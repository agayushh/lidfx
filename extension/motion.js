import GLib from 'gi://GLib';

export function nowSeconds() {
    return GLib.get_monotonic_time() / 1_000_000;
}

function clamp(value, lo, hi) {
    return Math.min(Math.max(value, lo), hi);
}

export class LidMotion {
    constructor(openAngle = 100) {
        this._angle = null;
        this._trackedAngle = null;
        this._angularVelocity = 0;
        this._direction = 0;
        this._baseline = openAngle;
        this._enabled = false;
        this._target = 0;
        this._displayed = 0;
        this._displayVelocity = 0;
        this._lastFrame = 0;
        this._lastSample = 0;
    }

    receive(value, time = nowSeconds()) {
        const changed = (this._angle == null) !== (value == null);
        const previous = this._target;
        this._angle = value;
        if (value != null && this._trackedAngle != null && this._lastSample > 0 && time >= this._lastSample) {
            const delta = Math.max(time - this._lastSample, 0.001);
            const nextAngle = clamp(this._trackedAngle, value - 0.6, value + 0.6);
            if (nextAngle < this._trackedAngle)
                this._direction = 1;
            else if (nextAngle > this._trackedAngle)
                this._direction = -1;
            const measuredVelocity = (nextAngle - this._trackedAngle) / delta;
            this._angularVelocity += (measuredVelocity - this._angularVelocity) * (1 - Math.exp(-delta / 0.06));
            this._trackedAngle = nextAngle;
        } else {
            this._trackedAngle = value;
            this._angularVelocity = 0;
            this._direction = 0;
        }
        this._lastSample = time;
        this._updateTarget(time);
        return {
            availabilityChanged: changed,
            available: value != null,
            beganClosing: previous === 0 && this._target > 0,
        };
    }

    calibrate() {
        if (this._angle == null || this._angle < 25)
            return null;
        this._baseline = this._angle;
        this._reset();
        return this._baseline;
    }

    setBaseline(value) {
        if (!Number.isFinite(value) || value < 25 || value > 180)
            return;
        this._baseline = value;
        this._reset();
        this._updateTarget();
    }

    get baseline() {
        return this._baseline;
    }

    setEnabled(value) {
        this._enabled = value;
        this._reset();
        this._updateTarget();
    }

    snapProgress(progress) {
        const value = clamp(progress, 0, 1);
        this._target = value;
        this._displayed = value;
        this._displayVelocity = 0;
        this._direction = 0;
        this._lastFrame = 0;
    }

    _reset() {
        this._trackedAngle = this._angle;
        this._angularVelocity = 0;
        this._direction = 0;
        this._target = 0;
        this._displayed = 0;
        this._displayVelocity = 0;
        this._lastFrame = 0;
    }

    _updateTarget(time = nowSeconds()) {
        if (!this._enabled || this._baseline <= 8 || this._angle == null ||
            this._trackedAngle == null || this._angle >= this._baseline) {
            this._target = 0;
            if (this._enabled)
                this._direction = -1;
            return;
        }
        const prediction = clamp(this._velocity(time) * 0.035, -0.75, 0.75);
        this._target = clamp(
            (this._baseline - 0.6 - this._trackedAngle - prediction) / (this._baseline - 8.6),
            0, 1);
    }

    sample(time = nowSeconds()) {
        if (!this._enabled || this._angle == null) {
            this._displayed = 0;
            this._displayVelocity = 0;
            return 0;
        }
        this._updateTarget(time);
        const elapsed = time - this._lastFrame;
        const delta = this._lastFrame > 0 && elapsed < 0.1
            ? clamp(elapsed, 0, 0.025)
            : 1.0 / 120;
        this._lastFrame = time;
        const frequency = 30 + Math.min(Math.abs(this._velocity(time)) * 0.55, 25);
        const offset = this._displayed - this._target;
        const travel = (this._displayVelocity + frequency * offset) * delta;
        const decay = Math.exp(-frequency * delta);
        const previous = this._displayed;
        this._displayed = this._target + (offset + travel) * decay;
        this._displayVelocity = (this._displayVelocity - frequency * travel) * decay;
        if ((this._direction > 0 && this._displayed < previous) ||
            (this._direction < 0 && this._displayed > previous)) {
            this._displayed = previous;
            this._displayVelocity = 0;
        }
        const canSettle = this._direction === 0 ||
            (this._direction > 0 && this._target >= this._displayed) ||
            (this._direction < 0 && this._target <= this._displayed);
        if (canSettle && Math.abs(this._displayed - this._target) < 0.00001 &&
            Math.abs(this._displayVelocity) < 0.0001) {
            this._displayed = this._target;
            this._displayVelocity = 0;
        }
        if (this._displayed < 0 || this._displayed > 1) {
            this._displayed = clamp(this._displayed, 0, 1);
            this._displayVelocity = 0;
        }
        return this._displayed;
    }

    _velocity(time) {
        return this._angularVelocity * Math.exp(-Math.max(time - this._lastSample - 0.025, 0) / 0.08);
    }

    get isClosing() {
        return this._target > 0;
    }
}
