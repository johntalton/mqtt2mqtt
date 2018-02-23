"use strict";

module.exports.handler = function (topic, payload) {

  let labels = ['foo', 'bar']

  try {
    let json = JSON.parse(payload);
    if(json.labels !== undefined) {
      json.labels.concat(labels);
    }
    else {
      json.labels = labels;
    }

    return (topic, JSON.parse(json));
  } catch(e) {
    return (topic, payload);
  };
};
