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

function getOscillationTargets(presetName, parameter) {
    const channels = new Map();
    const fixtures = getCurrentModeFixtures();
    const addChannel = (ch, fixture, param, phase = 0) => {
        if (ch < 1 || ch > faderValues.length) return;
        channels.set(ch - 1, {
            fixture: fixture?.from || ch,
            brightness: ['Shutter', 'Dimmer'].includes(param) && fixture?.type !== 'Fog Machine',
            parameter: param,
            phase
        });
    };
    // Explicit sliders can modulate any channel, including motion and macros.
    if (selectedChannels.size && !['ledCircle', 'goboCircle'].includes(presetName)) {
        selectedChannels.forEach(ch => {
            const fixture = fixtures.find(f => ch >= f.from && ch <= f.to);
            addChannel(ch, fixture, fixtureParameters[fixture?.type]?.[ch - fixture?.from]?.name);
        });
        return channels;
    }
    fixtures.forEach(fixture => {
        const selected = selectedFixtures.has(fixture.from) || ['ledCircle', 'goboCircle'].includes(presetName) &&
            [...selectedChannels].some(ch => ch >= fixture.from && ch <= fixture.to);
        if (!selected) return;
        if (presetName === 'goboCircle' && fixture.type !== 'Motorized Par') return;
        if (presetName === 'ledCircle' && (!['LED', 'Uplighting', 'Auditorium LED'].includes(fixture.type) ||
            currentMode === 'Black Box' && !BLACK_BOX_LED_PERIMETER.includes(fixture.from))) return;
        if (parameter === 'brightness' && fixture.type === 'Fog Machine') return;
        const params = fixtureParameters[fixture.type] || [];
        params.forEach((param, offset) => {
            const ch = fixture.from + offset;
            if (ch > fixture.to) return;
            const wanted = presetName === 'goboCircle' ? ['Pan', 'Tilt'].includes(param.name)
                : presetName === 'ledCircle' || parameter === 'brightness' ? ['Shutter', 'Dimmer'].includes(param.name)
                : param.name === parameter;
            if (wanted) addChannel(ch, fixture, param.name, presetName === 'goboCircle' && param.name === 'Tilt' ? 0.25 : 0);
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
    const opener = document.getElementById('oscillationButton');
    if (opener) opener.textContent = activeOscillationChannels.size
        ? `Oscillations · ${activeOscillationChannels.size}` : 'Oscillations';
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
    const targets = getOscillationTargets(presetName, document.getElementById('oscillationParameter').value);
    if (!targets.size) {
        updateOscillationStatus(presetName === 'goboCircle' ? 'Select gobo fixtures for paired Pan/Tilt circles.'
            : presetName === 'ledCircle' ? 'Select LED fixtures for the circle chase.'
            : 'Select sliders, or lights with the chosen parameter.');
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
    document.getElementById('oscillationParameter').disabled = ['ledCircle', 'goboCircle'].includes(name);
    document.getElementById('oscillationWaveform').disabled = name === 'goboCircle';
    if (!['ledCircle', 'goboCircle'].includes(name)) document.getElementById('oscillationParameter').value = 'brightness';
    refreshOscillationRouteHelp();
}

function getLEDCircleRank(fixtureStart) {
    return currentMode === 'Black Box' ? BLACK_BOX_LED_PERIMETER.indexOf(fixtureStart) : fixtureStart;
}

function refreshOscillationRouteHelp() {
    const preset = document.getElementById('oscillationPreset').value;
    document.getElementById('oscillationRouteHelp').textContent = preset === 'ledCircle'
        ? currentMode === 'Black Box'
            ? 'LED Circle follows row 2 → right → row 1 → left. The middle row stays unchanged.'
            : 'LED Circle follows the selected LEDs in patch order.'
        : preset === 'goboCircle'
            ? 'Pan and tilt circle their starting positions. The radius stays within both axes’ limits.'
            : 'Brightness dims below its starting level. Other sliders move above and below their starting value.';
}

function refreshOscillationParameters() {
    const input = document.getElementById('oscillationParameter');
    const previous = input.value;
    const fixtures = getCurrentModeFixtures().filter(f => selectedFixtures.has(f.from));
    const names = fixtures.map(f => (fixtureParameters[f.type] || []).map(p => p.name).filter(name => name && name !== '-'));
    const common = names.length ? [...new Set(names[0])].filter(name => names.every(params => params.includes(name))) : [];
    input.replaceChildren();
    [['brightness', 'Brightness'], ...common.map(name => [name, name])].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        input.appendChild(option);
    });
    input.value = [...input.options].some(option => option.value === previous) ? previous : 'brightness';
}

document.getElementById('oscillationButton').addEventListener('click', () => {
    refreshOscillationParameters();
    refreshOscillationRouteHelp();
    document.getElementById('oscillationModal').showModal();
});
document.getElementById('oscillationPreset').addEventListener('change', loadOscillationPreset);
document.getElementById('oscillationStart').addEventListener('click', startOscillations);
document.getElementById('oscillationStop').addEventListener('click', () => stopOscillations());
document.getElementById('oscillationClose').addEventListener('click', () => {
    document.getElementById('oscillationModal').close();
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeOscillationChannels.size) stopOscillations('Stopped and restored when the page became hidden.');
});
window.addEventListener('pagehide', () => {
    if (activeOscillationChannels.size) stopOscillations();
});
