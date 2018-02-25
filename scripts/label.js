"use strict";

module.exports.handler = function (topic, payload) {
  let labels = ['foo', 'bar']

  if(payload === undefined) { return 'undefined payload'; }
  if(!Buffer.isBuffer(payload)){ throw Error('not a buffer'); }

  let json = {};
  if(payload.length === 0) { console.log('empty payload'); }
  else {
    try {
      json = JSON.parse(payload);
    } catch(e) {
      console.log('\t\tfailed to prase payload', e);
    }
  }

  if(json.labels !== undefined) {
    json.labels.concat(labels);
  }
  else {
    json.labels = labels;
  }

  return publish(topic, JSON.stringify(json));
};


