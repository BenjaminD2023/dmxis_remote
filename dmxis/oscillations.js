// Effects borrow selected channels while preserving their resting settings.
// A generation check releases them whenever a newer manual command takes over.
const OSCILLATION_PRESETS = Object.freeze({
    breathe: { waveform: 'sine', period: 4, depth: 80, stagger: false },
    pulse: { waveform: 'triangle', period: 2, depth: 100, stagger: false },
    chase: { waveform: 'sine', period: 2, depth: 100, stagger: true },
    shimmer: { waveform: 'sine', period: 0.8, depth: 35, stagger: true },
    ledCircle: { waveform: 'sine', period: 6, depth: 100, stagger: true },
    goboCircle: { waveform: 'sine', period: 4, depth: 20, stagger: false }
});
// Existing fixture labels follow row 2 → right → row 1 → left. The inner
// third row is separate; the patch has no coordinates or compass direction.
const BLACK_BOX_LED_PERIMETER = [170, 178, 186, 194, 202, 210, 218, 226, 234,
    242, 250, 258, 266, 274, 282, 290, 298, 306];
const activeOscillationChannels = new Set();
const oscillationChannels = new Map();
let oscillationTimer = null;
let oscillationStartedAt = 0;
let oscillationSettings = null;

function isOscillationChannelOwned(idx) {
    const channel = oscillationChannels.get(idx);
    return !!channel && pendingChannelIntents.get(idx)?.generation === channel.generation;
}

function getOscillationBaseValue(idx) {
    return isOscillationChannelOwned(idx) ? oscillationChannels.get(idx).base : undefined;
}

function getOscillationTargets(presetName) {
    const channels = new Map();
    const fixtures = getCurrentModeFixtures();
    selectedChannels.forEach(ch => {
        if (ch < 1 || ch > faderValues.length) return;
        const fixture = fixtures.find(f => ch >= f.from && ch <= f.to);
        const params = fixtureParameters[fixture?.type] || [];
        const parameter = params[ch - fixture?.from]?.name;
        const brightness = ['Shutter', 'Dimmer'].includes(parameter) && fixture?.type !== 'Fog Machine';
        if (presetName === 'ledCircle' && (!brightness || !['LED', 'Uplighting', 'Auditorium LED'].includes(fixture?.type) ||
            currentMode === 'Black Box' && !BLACK_BOX_LED_PERIMETER.includes(fixture.from))) return;
        if (presetName === 'goboCircle') {
            if (fixture?.type !== 'Motorized Par' || !['Pan', 'Tilt'].includes(parameter)) return;
            // Circular motion needs both axes explicitly selected. An effect
            // must never borrow another slider that the user did not select.
            const pan = fixture.from + params.findIndex(param => param.name === 'Pan');
            const tilt = fixture.from + params.findIndex(param => param.name === 'Tilt');
            if (!selectedChannels.has(pan) || !selectedChannels.has(tilt)) return;
        }
        channels.set(ch - 1, {
            fixture: fixture?.from || ch,
            brightness,
            parameter,
            phase: presetName === 'goboCircle' && parameter === 'Tilt' ? 0.25 : 0
        });
    });
    return channels;
}

function oscillationLevel(base, phase, settings, brightness = true, radius = 127 * settings.depth / 100) {
    phase = ((phase % 1) + 1) % 1;
    let wave = settings.waveform === 'square' ? (phase < 0.5 ? 1 : 0)
        : settings.waveform === 'triangle' ? Math.abs(2 * phase - 1)
        : (1 + Math.cos(phase * Math.PI * 2)) / 2;
    if (settings.presetName === 'ledCircle') wave = wave ** 8;
    const value = brightness ? base * (1 - settings.depth / 100 * (1 - wave))
        : base + radius * (2 * wave - 1);
    return Math.max(0, Math.min(127, Math.round(value)));
}

function updateOscillationStatus(message) {
    const status = document.getElementById('oscillationStatus');
    if (status) status.textContent = message;
    const stop = document.getElementById('oscillationStop');
    if (stop) stop.disabled = activeOscillationChannels.size === 0;
}

function refreshOscillationSelection() {
    const selection = document.getElementById('oscillationSelection');
    const count = selectedChannels.size;
    const parameters = new Set([...getOscillationTargets('breathe').values()].map(target => target.parameter).filter(Boolean));
    if (selection) selection.textContent = count
        ? `${count} slider${count === 1 ? '' : 's'} selected${parameters.size === 1 ? ` · ${[...parameters][0]}` : ''}`
        : 'Select sliders to oscillate.';
    const start = document.getElementById('oscillationStart');
    if (start) start.disabled = count === 0;
}

function applyOscillationValue(idx, value) {
    if (faderValues[idx] === value) return;
    faderValues[idx] = value;
    updateSliderState(idx, value);
    sendMIDICC(Math.floor(idx / 128), idx % 128, value, { transient: true });
}

function tickOscillations() {
    oscillationTimer = null;
    if (document.hidden) {
        stopOscillations('Stopped and restored when the page became hidden.');
        return;
    }
    const phase = (performance.now() - oscillationStartedAt) / (oscillationSettings.period * 1000);
    let releasedChannel = false;
    oscillationChannels.forEach((channel, idx) => {
        if (!isOscillationChannelOwned(idx)) {
            // A manual edit or color command takes ownership. Never restore an
            // old baseline over the newer command, including during a flash.
            oscillationChannels.delete(idx);
            activeOscillationChannels.delete(idx);
            releasedChannel = true;
            return;
        }
        if (isChannelFlashing(idx)) return;
        applyOscillationValue(idx, oscillationLevel(channel.base, phase + channel.phase, oscillationSettings, channel.brightness, channel.radius));
    });
    if (activeOscillationChannels.size) {
        if (releasedChannel) updateOscillationStatus(`Running on ${activeOscillationChannels.size} channels. Edited channels were released.`);
        oscillationTimer = setTimeout(tickOscillations, 40); // At most 25 updates/sec.
    } else {
        updateOscillationStatus('Stopped: the selected settings were changed.');
    }
}

function startOscillations() {
    const presetName = document.getElementById('oscillationPreset').value;
    const preset = OSCILLATION_PRESETS[presetName];
    const settings = {
        waveform: document.getElementById('oscillationWaveform').value,
        period: Number(document.getElementById('oscillationPeriod').value),
        depth: Number(document.getElementById('oscillationDepth').value),
        stagger: preset?.stagger || false,
        presetName
    };
    if (!['sine', 'triangle', 'square'].includes(settings.waveform) ||
        !Number.isFinite(settings.period) || settings.period < 0.5 || settings.period > 20 ||
        !Number.isFinite(settings.depth) || settings.depth < 0 || settings.depth > 100) {
        updateOscillationStatus('Use a cycle of 0.5–20 seconds and a depth of 0–100%.');
        return;
    }
    if (!midiOutput) {
        updateOscillationStatus('Choose a MIDI output in the menu before starting.');
        return;
    }
    const targets = getOscillationTargets(presetName);
    if (!targets.size) {
        updateOscillationStatus(presetName === 'goboCircle' ? 'Select both Pan and Tilt sliders for each gobo.'
            : presetName === 'ledCircle' ? 'Select LED shutter or dimmer sliders for the circle chase.'
            : 'Select sliders before starting.');
        return;
    }
    const bases = new Map();
    for (const idx of targets.keys()) {
        const value = getIntendedChannelValue(idx);
        if (!Number.isInteger(value) || value < 0 || value > 127) {
            updateOscillationStatus('A starting value is unknown. Read current levels in DMXIS before starting.');
            return;
        }
        if (value > 0 || !targets.get(idx).brightness) bases.set(idx, value);
    }
    if (presetName === 'goboCircle') {
        const fixtureStarts = [...new Set([...targets.values()].map(target => target.fixture))];
        fixtureStarts.forEach(start => {
            const axes = [...bases.keys()].filter(idx => targets.get(idx).fixture === start);
            const radius = axes.length === 2 ? Math.min(127 * settings.depth / 100,
                ...axes.flatMap(idx => [bases.get(idx), 127 - bases.get(idx)])) : 0;
            axes.forEach(idx => {
                if (radius === 0) bases.delete(idx);
                else targets.get(idx).radius = radius;
            });
        });
        if (!bases.size) {
            updateOscillationStatus('Set Pan and Tilt away from the end stops and choose a radius above zero for a circle.');
            return;
        }
    }
    if (!bases.size) {
        updateOscillationStatus('Raise the selected lights’ brightness before starting.');
        return;
    }
    stopOscillations();
    oscillationSettings = settings;
    const fixtures = [...new Set([...bases.keys()].map(idx => targets.get(idx).fixture))];
    if (presetName === 'ledCircle') fixtures.sort((a, b) => getLEDCircleRank(a) - getLEDCircleRank(b));
    bases.forEach((base, idx) => {
        oscillationChannels.set(idx, {
            base,
            generation: beginChannelIntent(idx, base, 'oscillation'),
            brightness: targets.get(idx).brightness,
            radius: targets.get(idx).radius,
            phase: targets.get(idx).phase + (settings.stagger ? -fixtures.indexOf(targets.get(idx).fixture) / fixtures.length : 0)
        });
        activeOscillationChannels.add(idx);
    });
    oscillationStartedAt = performance.now();
    updateOscillationStatus(`Running on ${bases.size} channel${bases.size === 1 ? '' : 's'}.${bases.size < targets.size
        ? presetName === 'goboCircle' ? ' Gobos at an end stop were skipped.' : ' Lights at zero brightness were skipped.' : ''}`);
    tickOscillations();
}

function stopOscillations(message = 'Stopped and restored the original settings.') {
    clearTimeout(oscillationTimer);
    oscillationTimer = null;
    oscillationChannels.forEach((channel, idx) => {
        if (!isOscillationChannelOwned(idx)) return;
        if (isChannelFlashing(idx)) {
            activeFlashRestores.set(idx, channel.base);
        } else {
            if (typeof protectFlashRestore === 'function') protectFlashRestore(idx, channel.base);
            faderValues[idx] = channel.base;
            updateSliderState(idx, channel.base);
            sendMIDICC(Math.floor(idx / 128), idx % 128, channel.base);
        }
        pendingChannelIntents.delete(idx);
    });
    oscillationChannels.clear();
    activeOscillationChannels.clear();
    updateOscillationStatus(message);
}

function loadOscillationPreset() {
    const preset = OSCILLATION_PRESETS[document.getElementById('oscillationPreset').value];
    document.getElementById('oscillationWaveform').value = preset.waveform;
    document.getElementById('oscillationPeriod').value = preset.period;
    document.getElementById('oscillationDepth').value = preset.depth;
    const name = document.getElementById('oscillationPreset').value;
    document.getElementById('oscillationWaveform').disabled = name === 'goboCircle';
    refreshOscillationRouteHelp();
}

function getLEDCircleRank(fixtureStart) {
    return currentMode === 'Black Box' ? BLACK_BOX_LED_PERIMETER.indexOf(fixtureStart) : fixtureStart;
}

function refreshOscillationRouteHelp() {
    const preset = document.getElementById('oscillationPreset').value;
    document.getElementById('oscillationRouteHelp').textContent = preset === 'ledCircle'
        ? currentMode === 'Black Box'
            ? 'Selected LED brightness sliders: row 2 → right → row 1 → left; middle row excluded.'
            : 'Selected LED brightness sliders follow patch order.'
        : preset === 'goboCircle'
            ? 'Select Pan + Tilt. Double-click one axis, then Cmd/Ctrl-double-click the other.'
            : 'Double-click a slider for its whole category. Cmd/Ctrl-double-click adds another parameter.';
}
document.getElementById('oscillationPreset').addEventListener('change', loadOscillationPreset);
function focusSelectedSlider() {
    document.activeElement.blur?.();
    const channel = lastSelectedChannel || [...selectedChannels][0];
    document.getElementById(`fader-${channel - 1}`)?.focus?.();
}
document.getElementById('oscillationStart').addEventListener('click', () => {
    startOscillations();
    focusSelectedSlider();
});
document.getElementById('oscillationStop').addEventListener('click', () => {
    stopOscillations();
    focusSelectedSlider();
});
document.addEventListener('DOMContentLoaded', refreshOscillationSelection);
document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeOscillationChannels.size) stopOscillations('Stopped and restored when the page became hidden.');
});
window.addEventListener('pagehide', () => {
    if (activeOscillationChannels.size) stopOscillations();
});
