"use strict";

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mqtt = require('mqtt');

class Config {
  static config(path) {
    return new Promise((resolve, reject) => {
      fs.readFile(path, 'utf8', (err, data) => {
        if(err) { reject(err); return; }
        resolve(JSON.parse(data));
      });
    });
  }
}

class Broker {
  static setupBrokers(config) {
    return Promise.all(config.brokers.map(Broker.make)).then(() => config);
  }

  static make(broker) {
    let client = mqtt.connect(broker.url, { reconnectPeriod: broker.reconnectMs });
    client.on('connect', () => { console.log('connected', broker.name); });
    client.on('reconnect', () => { });
    client.on('close', () => { });
    client.on('offline', () => { console.log('offline', broker.name); });
    client.on('error', (error) => { console.log(error); process.exit(-1); });

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

    let p = path.normalize(path.join(config.bindingsRoot, binding.path));
    let filename = binding.path;
    let timeoutMs = 3 * 1000;

    return new Promise((resolve, reject) => {
      fs.readFile(p, 'utf8', (err, data) => {
        if(err) { reject(err); return; }
        resolve(data);
      });
    })
    .then(code => {
      binding.client = new vm.Script(code, { filename: filename, timeout: timeoutMs })
      binding.status = 'offline';
    })
    .catch(e => {
      console.log('error setting up binding', binding.name, e);
      binding.status = 'error';
      binding.message = e.message;
    });
  }
}


if(!module.parent) {
  Config.config('./client.json')
    .then(Broker.setupBrokers)
    .then(Binding.setupBindings)

    .then(console.log)
    .catch(e => console.log('top-level error', e));
}
