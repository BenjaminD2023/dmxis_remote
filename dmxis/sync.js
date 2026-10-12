// DMXIS sends live OSC feedback to the local Python server. Receiving a level
// updates the remote only; it must never send that level back as a MIDI command.
const dmxisSync = {
    available: false,
    connected: false,
    instanceId: null,
    known: new Set(),
    appliedAt: new Array(512).fill(0),
    baseValues: new Array(512).fill(null),
    baseUpdatedAt: new Array(512).fill(0),
    localWrites: new Map()
};

function recordLocalChannelWrite(idx, value) {
    const at = Date.now();
    dmxisSync.localWrites.set(idx, { value, at });
    dmxisSync.baseValues[idx] = value;
    dmxisSync.baseUpdatedAt[idx] = at;
}

function getFlashRestoreValue(idx) {
    // OSC includes oscillators and sound tracking. Writing those live samples
    // back would change the underlying fader, so restore its separate baseline.
    return dmxisSync.available ? dmxisSync.baseValues[idx] : faderValues[idx];
}

function isChannelStatusKnown(idx) {
    return !dmxisSync.available || dmxisSync.known.has(idx) || dmxisSync.localWrites.has(idx);
}

function updateSyncStatus(message) {
    const status = document.getElementById('dmxisSyncStatus');
    if (status && status.textContent !== message) status.textContent = message;
}

function refreshSyncValueLabels() {
    document.querySelectorAll('.fader').forEach(slider => {
        const idx = Number(slider.id.replace('fader-', ''));
        const known = isChannelStatusKnown(idx);
        slider.setAttribute('aria-valuetext', known ? String(faderValues[idx]) : 'Unknown until DMXIS reports this channel');
        const input = slider.parentElement.querySelector('.fader-value');
        if (input && !input.classList.contains('editable')) {
            input.value = known ? Math.round(faderValues[idx] / 127 * 100) : '?';
        }
    });
}

function refreshSyncedFixtureColors(changed) {
    getCurrentModeFixtures().forEach(fixture => {
        const params = fixtureParameters[fixture.type];
        if (!params) return;
        const idxFor = name => {
            const offset = params.findIndex(param => param.name === name);
            return offset < 0 ? -1 : fixture.from + offset - 1;
        };
        const macroIdx = idxFor('Colors');
        const rgbIndices = ['Red', 'Green', 'Blue'].map(idxFor);
        let hex;
        if (fixture.type === 'Motorized Par') {
            if (!changed.has(macroIdx) || !dmxisSync.known.has(macroIdx)) return;
            const color = COLORS.find(color => GOBO_COLOR_MACROS[color.name] === faderValues[macroIdx]);
            hex = color ? color.hex : '#333333';
        } else {
            const whiteIdx = idxFor('White');
            const indices = [...rgbIndices, whiteIdx].filter(idx => idx >= 0);
            if (!rgbIndices.every(idx => idx >= 0) || !indices.some(idx => changed.has(idx)) ||
                !indices.every(idx => dmxisSync.known.has(idx))) return;
            const white = whiteIdx < 0 ? 0 : faderValues[whiteIdx];
            hex = '#' + rgbIndices.map(idx => Math.min(255, Math.round((faderValues[idx] + white) / 127 * 255))
                .toString(16).padStart(2, '0')).join('');
        }
        const state = { currentOpacity: 0.5, targetOpacity: 0.5, hex, rgba: hexToRGBA(hex, 0.5) };
        labelBackgroundStates.set(`label-${fixture.from}`, state);
        document.querySelectorAll(`.fixture-label[data-fixture="${fixture.from}"]`).forEach(label => {
            label.style.backgroundColor = state.rgba;
        });
    });
}

function applyDMXISStatus(snapshot) {
    if (!Array.isArray(snapshot.values) || snapshot.values.length !== 512 ||
        !Array.isArray(snapshot.updatedAt) || snapshot.updatedAt.length !== 512) return;
    dmxisSync.available = true;
    if (snapshot.instanceId && snapshot.instanceId !== dmxisSync.instanceId) {
        dmxisSync.instanceId = snapshot.instanceId;
        dmxisSync.known.clear();
        dmxisSync.appliedAt.fill(0);
    }
    dmxisSync.connected = snapshot.connected === true;
    if (!dmxisSync.connected) {
        updateSyncStatus('DMXIS sync: waiting for DMXIS');
        refreshSyncValueLabels();
        return;
    }
    const changed = new Set();
    if (Array.isArray(snapshot.baseValues) && snapshot.baseValues.length === 512 &&
        Array.isArray(snapshot.baseUpdatedAt) && snapshot.baseUpdatedAt.length === 512) {
        snapshot.baseValues.forEach((value, idx) => {
            const at = snapshot.baseUpdatedAt[idx];
            if (!Number.isInteger(value) || value < 0 || value > 127 || !Number.isFinite(at) || at <= dmxisSync.baseUpdatedAt[idx]) return;
            if (typeof activeFlashChannels !== 'undefined' && activeFlashChannels.has(idx)) return;
            dmxisSync.baseValues[idx] = value;
            dmxisSync.baseUpdatedAt[idx] = at;
        });
    }
    snapshot.values.forEach((value, idx) => {
        const receivedAt = snapshot.updatedAt[idx];
        if (!Number.isInteger(value) || value < 0 || value > 127 || !Number.isFinite(receivedAt) || receivedAt <= 0) return;
        dmxisSync.known.add(idx);
        if (receivedAt <= dmxisSync.appliedAt[idx]) return;
        if (typeof activeFlashChannels !== 'undefined' && activeFlashChannels.has(idx)) return;
        const slider = document.getElementById(`fader-${idx}`);
        const input = slider?.parentElement.querySelector('.fader-value');
        if (input?.classList.contains('editable')) return;
        const state = sliderStates.get(`fader-${idx}`);
        if (state && state.current !== state.target) return;
        const local = dmxisSync.localWrites.get(idx);
        // Ignore a snapshot older than our command, and delayed acknowledgements
        // while a flash or color fade is still being sent.
        if (local && (receivedAt <= local.at || (Date.now() - local.at < 350 && value !== local.value))) return;
        dmxisSync.appliedAt[idx] = receivedAt;
        dmxisSync.localWrites.delete(idx);
        faderValues[idx] = value;
        updateSliderState(idx, value);
        changed.add(idx);
    });
    refreshSyncedFixtureColors(changed);
    refreshSyncValueLabels();
    updateSyncStatus(dmxisSync.known.size === 512
        ? 'DMXIS synced · 512 channels'
        : `DMXIS synced · ${dmxisSync.known.size}/512 channels`);
}

async function pollDMXISStatus() {
    let delay = 250;
    try {
        const response = await fetch('/api/dmxis/status', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error('Local sync server unavailable');
        applyDMXISStatus(await response.json());
    } catch {
        dmxisSync.connected = false;
        updateSyncStatus('DMXIS sync: local server unavailable');
        delay = 2000;
    }
    setTimeout(pollDMXISStatus, delay);
}

document.addEventListener('DOMContentLoaded', pollDMXISStatus);
