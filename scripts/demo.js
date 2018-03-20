"use strict";

class Rotary2Servo {
  static handler(topic, message) {
    if(!topic.startsWith('rotaryEncoder/')){ throw Error('invalid message format'); }
    const json = JSON.parse(message);
    console.log('R2S', json.name, json.event);

    switch(json.event) {
      case 'UP': break;
      case 'DOWN':
        Rotary2Servo.active = (Rotary2Servo.active + 1) % Rotary2Servo.selectors.length;
        break;
      default:
        const selector = Rotary2Servo.selectors[Rotary2Servo.active];
        const angle = json.estValue * 10;
        const sheet = selector + ' { angle: ' + angle  + '; }';

        return publish('/CnC/pwm/you', sheet);
        break;
    }
  }
}


Rotary2Servo.selectors = [
  '#0', '#1',
  '.armLeft', '.armRight',
  '.fingerLeft', '.fingerRight'
];
Rotary2Servo.active = 0;


module.exports = {
  handler: Rotary2Servo.handler,
  Rotary2Servo: Rotary2Servo
};
