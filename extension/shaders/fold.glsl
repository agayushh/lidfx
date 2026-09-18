uniform sampler2D tex;
uniform float progress;
uniform float uWidth;
uniform float uHeight;

vec3 sampleRgb(vec2 uv) {
    vec2 c = clamp(uv, vec2(0.0), vec2(1.0));
    return texture2D(tex, c).rgb;
}

vec3 blurAt(vec2 uv, float px) {
    vec2 t = vec2(px / max(uWidth, 1.0), px / max(uHeight, 1.0));
    vec3 acc = sampleRgb(uv) * 0.20;
    acc += sampleRgb(uv + vec2(t.x, 0.0)) * 0.15;
    acc += sampleRgb(uv - vec2(t.x, 0.0)) * 0.15;
    acc += sampleRgb(uv + vec2(0.0, t.y)) * 0.15;
    acc += sampleRgb(uv - vec2(0.0, t.y)) * 0.15;
    acc += sampleRgb(uv + t) * 0.05;
    acc += sampleRgb(uv + vec2(-t.x, t.y)) * 0.05;
    acc += sampleRgb(uv + vec2(t.x, -t.y)) * 0.05;
    acc += sampleRgb(uv + vec2(-t.x, -t.y)) * 0.05;
    return acc;
}

void main() {
    vec2 inuv = cogl_tex_coord_in[0].st;
    float q = (1.0 + 0.30 * progress) / (1.0 + 0.30 * progress * inuv.y);
    vec2 uv = vec2((inuv.x - 0.5) * q + 0.5, inuv.y * q);
    float edge = min(uv.x, 1.0 - uv.x);
    vec3 color;
    if (progress < 0.0001) {
        color = sampleRgb(inuv);
    } else if (edge <= 0.0) {
        color = blurAt(uv, 36.0);
    } else {
        float amount = 36.0 * progress * (1.0 - smoothstep(0.0, 0.9, uv.y));
        if (amount < 6.0) {
            color = mix(sampleRgb(uv), blurAt(uv, 6.0), amount / 6.0);
        } else if (amount < 16.0) {
            color = mix(blurAt(uv, 6.0), blurAt(uv, 16.0), (amount - 6.0) / 10.0);
        } else {
            color = mix(blurAt(uv, 16.0), blurAt(uv, 36.0), clamp((amount - 16.0) / 20.0, 0.0, 1.0));
        }
        float upper = 1.0 - smoothstep(0.0, 0.85, uv.y);
        float corners = (1.0 - smoothstep(0.0, 0.19, edge)) * upper;
        color *= 1.0 - progress * (0.50 * corners + 0.10 * upper);
        float feather = smoothstep(0.0, max(0.0001, progress * 0.012 * (1.0 - uv.y)), edge);
        if (feather < 1.0)
            color = mix(blurAt(uv, 36.0), color, feather);
    }
    cogl_color_out = vec4(color, 1.0) * cogl_color_in;
}
