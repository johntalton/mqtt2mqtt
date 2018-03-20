"use strict";

//import EventEmitter from 'events';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// const vm2 = require('vm2');

const mqtt = require('mqtt');

class Config {
  static config(cfgpath) {
    return new Promise((resolve, reject) => {
      fs.readFile(cfgpath, 'utf8', (err, data) => {
        if(err) { reject(err); return; }
        resolve(JSON.parse(data));
      });
    })
    .then(config => Config._normalize(config))
  }

  static _normalize(config) {
    const brokers = config.brokers.map((broker, index) => {
      const name = broker.name ? broker.name : index;
      const url = (broker.url !== undefined) ? broker.url : process.env.mqtturl;
      const S = broker.reconnectS ?  broker.reconnectS : 0;
      const Ms = broker.reconnectMs ?  broker.reconnectMs : 0;
      const reconnectMs = S * 1000 + Ms;

      return {
        name: name,
        url: url,
        reconnectMs: reconnectMs
      };
    });

    const bindings = config.bindings.map((binding, index) => {
      const p = binding.path;
      const fn = binding.fn;

      if(p && fn) { console.log('cache and/or proxy not supported'); throw Error('path or function only'); }
      else if(fn && !p) {
      }
      else if(p && !fn) {
        try {
          const np = path.parse(p);
        }
        catch(e) {
          console.log('path not parsable', p, e.message);
        }

      }
      else {
        throw Error('path or function missing');
      }

      const namefrompath = p ? path.basename(path.normalize(p), path.extname(p)) : p;
      const fallbackname = namefrompath ? namefrompath : index;
      const name = binding.name ? binding.name : fallbackname;

      const from = Config._normalizeToFrom(binding.from);
      const to = Config._normalizeToFrom(binding.to);

      const active = (binding.active !== undefined) ? binding.active : true;

      return {
        name: name,
        from: from,
        to: to,
        path: p,
        fn: fn,
        active
      };
    });

    const broot = config.bindingsRoot ? config.bindingsRoot : '.';

    return {
      brokers: brokers,
      bindings: bindings,
      bindingsRoot: broot
    };
  }

  static _normalizeToFrom(tf) {
    if(tf === undefined) { return { brokers: [0], topic: '#' }; }

    const topic = tf.topic ? tf.topic : '#';

    let brokers = [0];
    if(tf.broker) { brokers = tf.broker; }
    if(tf.brokers) { brokers = tf.brokers; }
    if(!Array.isArray(brokers)) { brokers = [brokers]; }

    console.log('brokers', typeof brokers, brokers);

    return {
      brokers: brokers,
      topic: topic
    };
  }
}

class Broker {
  static setupBrokers(config) {
    return Promise.all(config.brokers.map(broker => Broker.make(config, broker))).then(() => config);
  }

  static make(config, broker) {
    let client = mqtt.connect(broker.url, { reconnectPeriod: broker.reconnectMs });
    client.on('connect', () => { console.log('connected', broker.name); broker.status = 'online'; Binding.brokerUp(config, broker); });
    client.on('reconnect', () => { });
    client.on('close', () => { });
    client.on('offline', () => { console.log('offline', broker.name); broker.status = 'offline'; Binding.brokerDown(config, broker); });
    client.on('error', (error) => { console.log(error); process.exit(-1); });

    broker.status = 'init';
    broker.client = client;
    return true;
  }
}

class Binding {
  static setupBindings(config) {
    return Promise.all(config.bindings.map(binding => Binding.make(config, binding))).then(() => config);
  }

  static make(config, binding) {
    if(binding.active === false) { binding.status = 'inactive'; return; }

    let filename = binding.path;
    let timeoutMs = 3 * 1000;

    if(binding.path === undefined) {
      binding.status = 'error';
      binding.message = 'non path bindings not supported';
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const p = path.normalize(path.join(config.bindingsRoot, binding.path));
      fs.readFile(p, 'utf8', (err, data) => {
        if(err) { reject(err); return; }
        resolve([p, data]);
      });
    })
    .then(([p, code]) => {
      binding.client = {};
      binding.client.script = new vm.Script(code, { filename: filename, timeout: timeoutMs });
      binding.status = 'init';

      fs.watch(p, {}, (eventType, filename) => {
        console.log('XXX file modified... realod', binding.name, eventType, filename);
        Binding.make(config, binding)
          .catch(e => {
            console.log('Re-make binding error', e);
          });
      });

      return Binding._load(config, binding)
        .then(() => { binding.status = 'offline'; });
    })
    .catch(e => {
      console.log('error setting up binding', binding.name, e.message);
      binding.status = 'error';
      binding.message = e.message;
    });
  }

  static brokerUp(config, broker) {
    console.log('-- broker up --');
    return config.bindings
      .filter(b => b.status === 'offline')
      .filter(b => (b.from.brokers.includes(broker.name) || b.to.brokers.includes(broker.name)))
      .filter(b => b.active)
      .map(b => {
        console.log('a binding is effected by broker up, check', b.name);
        // create a unique array of broker names from the set of all broker needed
        // by this binding.  validate each broker is online and reduce result for all up status
        const checkbrokernamesStatusAll = [...new Set(b.from.brokers.concat(b.to.brokers))]
          .map(cbname => config.brokers.find(b => b.name === cbname).status === 'online')
          .reduce((all, bstatus) => all & bstatus);
        if(!checkbrokernamesStatusAll) { return true; }
        return Binding.startAllWithRetry(config, b, broker);
      });
  }

  static startAllWithRetry(config, binding, broker) {
    console.log('start all with retry for binding', binding.name);
    return Binding._startAll(config, binding, broker)
      .then(() => binding.status = 'online')
      .catch(e => {
        console.log('first start error', e);
        Binding.retry(config, binding, broker);
      });
  }

  static _startAll(config, binding, lastBroker) {
    const handler = (topic, message) => {
      return Binding._handleMessage(config, binding, topic, message);
    };

    const from = binding.from.brokers.map(fbname => {
      const fb = config.brokers.find(b => fbname === b.name);
      return new Promise((resolve, reject) => {
        const topic = binding.from.topic;
        fb.client.subscribe(topic, {}, (err, granted) => {
          if(err) { reject(err); }
          const [gtopic, gqos] = granted;

          fb.client.on('message', (topic, message, packet) => {
            console.log('message!', topic, message);
            handler(topic, message)
              .catch(e => { console.log('message handler error', e); });
          });

          resolve();
        });
      });
    });

   return Promise.all(from);
  }

  static retry(config, binding, broker) {
    
  }

  static brokerDown(config, broker) {
    console.log('-- broker down --');

  }




  static _handleMessage(config, binding, topic, message) {
    return Binding._run(config, binding, topic, message)
      .then(result => {
        //console.log('binding run result', binding.client.sandbox);
        //return null;
        return Promise.all(binding.to.brokers.map(tname => {
          const tb = config.brokers.find(b => b.name === tname);
          if(tb === undefined) { throw Error('to broker not found', binding.name, tname); }
          console.log('to publish for binding', binding.name, tb.name, binding.client.sandbox.publishQueue.length);
          return Promise.all(binding.client.sandbox.publishQueue.map(outmsg => {
            return new Promise((resolve, reject) => {
              const ptopic = Binding._makeToTopic(binding.to.topic, 'topic_from_queue');
              const pmsg = outmsg;
              console.log('sandbox publish message to broker', tb.name,  ptopic, pmsg);
              tb.client.publish(ptopic, pmsg, {}, err => {
                if(err) { console.log('error publishing', e); reject(err); return; }
                console.log('publish success!');
                resolve();
              });
            })
            .catch(e=> {
              console.log('publish error', e);
            });
          }));
        })).then(() => binding.client.sandbox.publishQueue = []);
      });
  }

  static _makeToTopic(pattern, topic) {
    if(pattern === '#') { return topic; }
    if(pattern.includes('+')) { return pattern.replace('+', topic); }
    return pattern;
  }

  static _load(config, binding) {
    console.log('*** load binding', binding.name);

    binding.client.sandbox = undefined;

    const sandbox = {
      Buffer: Buffer,
      console: console,

      publishQueue: [],
      publish: undefined,

      timeoutMs: 2 * 1000,
      module: { exports: {} }
    };
    sandbox.publish = function(t, m) {
      console.log('PUB to Queue', t, m);
      sandbox.publishQueue.push(m);
      return 1;
    };


    return new Promise((resolve, reject) => {
      binding.client.script.runInNewContext(sandbox, {
        filename: '',
        displayErrors: true,
        timeout: sandbox.timeoutMs,
        contextName: 'load context #i',
        contextOrigin: 'urn://mqtt2mqtt'
      });

      binding.client.sandbox = sandbox;
      resolve();
    });
  }

  static _run(config, binding, topic, message) {
    console.log('*** run binding', binding.name);

    return new Promise((resolve, reject) => {
      const sandbox = binding.client.sandbox.module.exports;
//      sandbox.Buffer = Buffer;
//      sandbox.console = console;
//      sandbox.publishQueue = [];
//      sandbox.publish = (t, m) => { console.log('PUB to Queue - runtime', t, m); publishQueue.push(m); return 0; };
      sandbox.timoutMs = 2 * 1000;

      sandbox.status = undefined;
      sandbox.topic = topic;
      sandbox.message = message;

      // todo cache me
      const stubcode = 'status = handler(topic, message);';
      const stub = new vm.Script(stubcode, { filename: '_stub_', timeout: sandbox.timeoutMs });

      stub.runInNewContext(sandbox, {
        filename: '',
        displayErrors: true,
        timeout: sandbox.timeoutMs,
        contextName: 'run context #i',
        contextOrigin: 'urn://mqtt2mqtt'
      });

      console.log('after run sandbox', sandbox.status);
      resolve();
    });
  }
}


if(!module.parent) {
  Config.config('./client.json')
    .then(Binding.setupBindings)
    .then(Broker.setupBrokers)

    .then(console.log)
    .catch(e => console.log('top-level error', e));
}
