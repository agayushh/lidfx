import {LidMotion, nowSeconds} from '../extension/motion.js';
import {angleFromYZ, chooseAccelMapping} from '../extension/sensor.js';

const motion = new LidMotion(100);
motion.setEnabled(true);
const t0 = nowSeconds();
motion.receive(100, t0);
if (motion.sample(t0) !== 0)
    throw new Error('open lid should be zero');
motion.receive(40, t0 + 0.05);
const closing = motion.sample(t0 + 0.08);
if (!(closing > 0))
    throw new Error(`expected fold while closing, got ${closing}`);

function near(value, expected, slack = 1.5) {
    if (Math.abs(value - expected) > slack)
        throw new Error(`expected ${expected}±${slack}, got ${value}`);
}

near(angleFromYZ(0, 1), 0);
near(angleFromYZ(-0.94, -0.10), 96.1);
near(angleFromYZ(0, -1), 180);
const mapping = chooseAccelMapping(0, -0.94, -0.10, true);
if (!mapping || mapping.length !== 2)
    throw new Error('expected an accelerometer axis mapping');

print(`ok motion closing=${closing.toFixed(3)} accel=${angleFromYZ(-0.94, -0.10).toFixed(1)}`);
