import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

function asFloat(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return 1e-6;
    return n === Math.floor(n) ? n + 1e-6 : n;
}

function loadShader(dir) {
    const file = dir.get_child('shaders').get_child('fold.glsl');
    const [, bytes] = file.load_contents(null);
    return new TextDecoder().decode(bytes);
}

export const FoldEffect = GObject.registerClass({
    GTypeName: 'LidFxFoldEffect',
}, class FoldEffect extends Clutter.ShaderEffect {
    _init(shaderSource) {
        super._init();
        this._progress = 0;
        this._compiled = this.set_shader_source(shaderSource);
        if (this._compiled) {
            try {
                this.set_uniform_value('tex', 0);
            } catch {
                // sampler defaults to texture unit 0
            }
            this.setFold(0, 1, 1);
        } else {
            logError(new Error('fold shader failed to compile'), 'LidFx');
        }
    }

    get compiled() {
        return this._compiled;
    }

    setFold(progress, width, height) {
        this._progress = progress;
        if (!this._compiled)
            return;
        this.set_uniform_value('progress', asFloat(progress));
        this.set_uniform_value('uWidth', asFloat(width));
        this.set_uniform_value('uHeight', asFloat(height));
        this.queue_repaint();
    }
});

export function createFoldEffect(extensionDir) {
    return new FoldEffect(loadShader(extensionDir));
}
