/**
 * SATHI — Camera-First Accessibility Companion
 * Features: Scene Memory, Proximity beep, haptic, read text, flashlight, low-light
 *
 * SATHI SAFETY-FIRST PROTOCOL:
 * 1. IMMEDIATE: Collision/obstacle → urgent voice + haptic warning
 * 2. PROACTIVE: Walls/stairs/hazards checked every 45s via LLM
 * 3. HEARTBEAT: Subtle vibration every 30s so blind user knows app is alive
 * 4. RESPONSIVE: Double-tap = instant safety scan
 * 5. VOICE: "check path", "check stairs", "is it safe" for on-demand safety
 * 6. FALL: Auto-detect falls and trigger SOS if no response
 * 7. GUARDIAN: All events logged to guardian dashboard
 */
import { getTranslation } from './services/translations.js';
import * as visionAI from './services/visionService.js';

// ===== STATE =====
let appState = 'login'; // 'login', 'onboarding', 'camera'
let onboardingStep = 0;
let lang = 'en-US';
let stream = null;
let isCaptionMode = false;
let isDescribing = false;
let lastDescription = '';
let flashlightOn = false;
let recognition = null;
let recognitionActive = false;
let transcriptBuffer = '';
let lastObstacleWarn = 0;
let lastUserCommandTime = 0;
let lastDescribeTime = 0;
let motionBuffer = [];
let wakeLock = null;
let lastTiltWarn = 0;
let conversationHistory = [];

// ===== FALL DETECTION STATE =====
let fallDetected = false;
let fallCountdownTimer = null;
let fallCountdownValue = 15; // seconds before auto-SOS
let lastFallAlertTime = 0;
let fallAccelBuffer = []; // stores recent acceleration magnitudes
let lastFallCheckTime = 0;

const CHIP_SETS = [
    ["Is it safe?", "Read text", "What's that?"],
    ["Tell me more", "Any hazards?", "Describe left side"]
];
let chipSetIndex = 0;
const app = document.getElementById('app');

// ===== SCENE MEMORY =====
const SceneMemory = {
    memories: [],
    MAX: 20,

    add(description, objects) {
        const loc = window.lastKnownLocation || null;
        this.memories.push({
            description,
            objects: objects || [],
            timestamp: Date.now(),
            location: loc ? { ...loc } : null
        });
        if (this.memories.length > this.MAX) this.memories.shift();
        this.updateBadge();
    },

    getContext() {
        if (this.memories.length === 0) return '';
        const recent = this.memories.slice(-5).map((m, i) => {
            const ago = Math.round((Date.now() - m.timestamp) / 60000);
            return `[${ago} min ago]: ${m.description}`;
        }).join('\n');
        return `\n\nSCENE MEMORY (recent places user visited):\n${recent}\n\nIf current scene resembles a past memory, mention it naturally like "This looks similar to the area you passed X minutes ago."`;
    },

    updateBadge() {
        const el = document.getElementById('memory-badge');
        if (el) {
            el.textContent = `🧠 MEMORY: ${this.memories.length}`;
            el.classList.add('active');
            setTimeout(() => el.classList.remove('active'), 2000);
        }
    }
};

// ===== PROXIMITY BEEP (ENHANCED FOR SAFETY) =====
const ProximityBeep = {
    audioCtx: null, beepTimer: null, closestDist: Infinity,
    init() { if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); },
    beep(freq = 880, dur = 80) {
        if (!this.audioCtx) this.init();
        const osc = this.audioCtx.createOscillator();
        const g = this.audioCtx.createGain();
        osc.connect(g); g.connect(this.audioCtx.destination);
        osc.frequency.value = freq; g.gain.value = 0.2;
        osc.start(); osc.stop(this.audioCtx.currentTime + dur / 1000);
    },
    update(dist) {
        this.closestDist = dist;
        clearInterval(this.beepTimer);
        if (dist > 3.0) return;
        let interval, freq;
        // DANGER ZONE — almost touching
        if (dist < 0.3) { interval = 60; freq = 1500; if (navigator.vibrate) navigator.vibrate([80, 30, 80, 30, 80]); }
        else if (dist < 0.5) { interval = 100; freq = 1200; if (navigator.vibrate) navigator.vibrate([100, 50, 100]); }
        else if (dist < 1.0) { interval = 200; freq = 1000; if (navigator.vibrate) navigator.vibrate(80); }
        else if (dist < 1.5) { interval = 400; freq = 880; }
        else if (dist < 2.5) { interval = 700; freq = 660; }
        else { interval = 1000; freq = 440; }
        this.beep(freq, 60);
        this.beepTimer = setInterval(() => this.beep(freq, 60), interval);
        setTimeout(() => clearInterval(this.beepTimer), 3000);
    },
    stop() { clearInterval(this.beepTimer); this.closestDist = Infinity; }
};

// ===== LOW LIGHT + AUTO FLASHLIGHT =====
let lastLowLightWarn = 0;
let autoFlashEnabled = false; // tracks if flashlight was turned on automatically
let lastLightCheck = 0; // cooldown for light checks
const checkLowLight = (video) => {
    try {
        // Guard: skip if no real video feed
        if (!video || !video.videoWidth || video.videoWidth < 10) return;
        // Cooldown: only check every 15 seconds to prevent looping
        const now = Date.now();
        if (now - lastLightCheck < 15000) return;
        lastLightCheck = now;

        const c = document.createElement('canvas'); c.width = 64; c.height = 48;
        const ctx = c.getContext('2d'); ctx.drawImage(video, 0, 0, 64, 48);
        const data = ctx.getImageData(0, 0, 64, 48).data;
        let b = 0; for (let i = 0; i < data.length; i += 16) b += (data[i] + data[i + 1] + data[i + 2]) / 3;
        const avg = b / (data.length / 16);

        // Auto-enable flashlight in very dark environments (not on desktop / no-camera)
        if (avg < 30 && !flashlightOn && stream) {
            toggleFlashlight(true, true);
            autoFlashEnabled = true;
        } else if (avg > 80 && flashlightOn && autoFlashEnabled) {
            // Enough ambient light — auto-disable (only if we turned it on)
            toggleFlashlight(false, true);
            autoFlashEnabled = false;
        }
    } catch (e) { }
};

// Periodic light-level check every 5 seconds
const startLightLevelMonitor = () => {
    setInterval(() => {
        const video = document.getElementById('camera-feed');
        if (video && video.videoWidth) checkLowLight(video);
    }, 5000);
};

// ===== FLASHLIGHT =====
const toggleFlashlight = async (on, silent = false) => {
    try {
        if (!stream) return;
        const track = stream.getVideoTracks()[0]; if (!track) return;
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if ('torch' in caps) {
            await track.applyConstraints({ advanced: [{ torch: on }] });
            flashlightOn = on;
            if (!silent) {
                speak(on ? 'Flashlight on.' : 'Flashlight off.', true);
            }
            showAIBubble(on ? '🔦 Flashlight ON' : '🔦 Flashlight OFF');
        } else if (!silent) { speak('Flashlight not available on this device.', true); }
    } catch (e) { if (!silent) speak('Could not control flashlight.', true); }
};

// ===== GUIDE ZONE =====
const GUIDE = { topLeft: 0.15, topRight: 0.85, bottomLeft: 0.0, bottomRight: 1.0, top: 0.15, bottom: 1.0 };
const isInsideGuideZone = (bbox, cw, ch) => {
    const [bx, by, bw, bh] = bbox;
    const cx = (bx + bw / 2) / cw, cy = (by + bh / 2) / ch;
    if (cy < GUIDE.top || cy > GUIDE.bottom) return false;
    const t = (cy - GUIDE.top) / (GUIDE.bottom - GUIDE.top);
    const left = GUIDE.topLeft + t * (GUIDE.bottomLeft - GUIDE.topLeft);
    const right = GUIDE.topRight + t * (GUIDE.bottomRight - GUIDE.topRight);
    return cx >= left && cx <= right;
};

// ===== WAKE LOCK — keep screen on =====
const keepScreenOn = async () => {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            speak('Screen will stay on.', false);
        }
    } catch (e) { /* silent — not critical */ }
};

// ===== CAMERA ZOOM =====
const setZoom = async (level) => {
    try {
        if (!stream) return;
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities();
        if (caps.zoom) {
            const min = caps.zoom.min, max = caps.zoom.max;
            const zoom = min + (max - min) * level;
            await track.applyConstraints({ advanced: [{ zoom }] });
            speak(`Zoom set to ${Math.round(level * 100)} percent`, true);
        } else { speak('Zoom not available on this device.', true); }
    } catch (e) { speak('Zoom not available.', true); }
};

// ===== BATTERY CHECK =====
const checkBattery = async () => {
    try {
        const b = await navigator.getBattery();
        const pct = Math.round(b.level * 100);
        const charging = b.charging ? ' and charging' : '';
        speak(`Battery is ${pct} percent${charging}`, true);
        if (pct < 20 && !b.charging) {
            speak('Warning. Battery is low. Please charge your phone.', true);
            if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
        }
    } catch (e) { speak('Could not read battery.', true); }
};

// ===== NETWORK CHECK =====
const checkNetwork = () => {
    const conn = navigator.connection;
    if (!navigator.onLine) {
        speak('No internet connection. SOS and vision features need internet.', true);
        if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
        return;
    }
    if (conn && conn.effectiveType) {
        speak(`Connected on ${conn.effectiveType} network.`, true);
    } else {
        speak('Connected to internet.', true);
    }
};

// ===== WHATSAPP SOS =====
const sendWhatsAppSOS = () => {
    const loc = window.lastKnownLocation || {};
    const lat = loc.latitude || '', lon = loc.longitude || '';
    const maps = `https://www.google.com/maps?q=${lat},${lon}`;
    const phone = guardianPhone || '';
    const msg = encodeURIComponent(`SATHI SOS ALERT: I need immediate help. My location: ${maps}`);
    if (phone) {
        window.open(`https://wa.me/${phone}?text=${msg}`);
        speak('WhatsApp message sent to guardian.', true);
    } else {
        speak('No guardian phone number saved. Complete onboarding first.', true);
    }
};

// ===== TIME AND DATE =====
const tellTime = () => {
    const now = new Date();
    const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    const date = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    speak(`It is ${time} on ${date}`, true);
};

// ===== VOLUME CONTROL =====
const setVolume = (level) => {
    if (ProximityBeep.audioCtx) {
        if (!window.globalGain) {
            window.globalGain = ProximityBeep.audioCtx.createGain();
            window.globalGain.connect(ProximityBeep.audioCtx.destination);
        }
        window.globalGain.gain.value = level;
    }
    speak(`Volume set to ${Math.round(level * 100)} percent`, true);
};

// ===== AUTO BATTERY + NETWORK LISTENERS =====
const initDeviceMonitors = () => {
    // Auto battery warning every 5 minutes
    setInterval(async () => {
        try {
            const b = await navigator.getBattery();
            if (b.level < 0.15 && !b.charging) {
                speak('Warning. Battery below 15 percent.', true);
                if (navigator.vibrate) navigator.vibrate([500, 200, 500]);
            }
        } catch (e) { }
    }, 300000);

    // Auto offline/online alerts
    window.addEventListener('offline', () => {
        speak('Internet disconnected. Working in offline mode.', true);
        if (navigator.vibrate) navigator.vibrate([500, 200, 500]);
    });
    window.addEventListener('online', () => {
        speak('Internet reconnected. All features restored.', true);
    });
};

// ===== CARE REMINDER ENGINE =====
// Polls /api/care-reminders every 60s and speaks due medicines/reminders
let spokenReminders = new Set(); // dedup: "med:Paracetamol:08:00" won't repeat within 10 min
let cachedMedicalInfo = null;

const initCareReminders = () => {
    const checkReminders = async () => {
        try {
            const res = await fetch('/api/care-reminders');
            if (!res.ok) return;
            const data = await res.json();
            cachedMedicalInfo = data.medical_info || null;

            (data.due || []).forEach(item => {
                const key = item.type === 'medicine'
                    ? `med:${item.name}:${item.time}`
                    : `rem:${item.text}:${item.time}`;

                if (spokenReminders.has(key)) return; // already spoken
                spokenReminders.add(key);

                // Auto-clear dedup after 10 minutes
                setTimeout(() => spokenReminders.delete(key), 600000);

                if (item.type === 'medicine') {
                    const msg = `Medicine reminder. Time to take ${item.name}. ${item.dosage ? 'Dosage: ' + item.dosage + '.' : ''} ${item.instructions || ''}`;
                    speak(msg, true);
                    showAIBubble(`💊 ${item.name} — ${item.dosage}`);
                    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
                } else {
                    speak(`Reminder: ${item.text}`, true);
                    showAIBubble(`🔔 ${item.text}`);
                    if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
                }
            });
        } catch (e) { /* offline — skip silently */ }
    };

    // Check every 60 seconds
    checkReminders();
    setInterval(checkReminders, 60000);
};

// Voice-accessible medical info queries
const tellMyMedicines = async () => {
    try {
        const res = await fetch('/api/care-profile');
        if (!res.ok) { speak('Could not load your medicine list.', true); return; }
        const data = await res.json();
        const meds = data.medicines || [];
        if (meds.length === 0) {
            speak('No medicines have been added yet. Ask your guardian to add them from the dashboard.', true);
            return;
        }
        let msg = `You have ${meds.length} medicine${meds.length > 1 ? 's' : ''}. `;
        meds.forEach((m, i) => {
            msg += `${i + 1}. ${m.name}, ${m.dosage}, scheduled at ${(m.times || []).join(' and ')}. `;
        });
        speak(msg, true);
    } catch (e) { speak('Could not load medicines right now.', true); }
};

const tellMyMedicalInfo = async () => {
    try {
        const res = await fetch('/api/care-profile');
        if (!res.ok) { speak('Could not load medical information.', true); return; }
        const data = await res.json();
        const mi = data.medical_info || {};
        let msg = 'Your medical information. ';
        if (mi.blood_type) msg += `Blood type: ${mi.blood_type}. `;
        if (mi.allergies) msg += `Allergies: ${mi.allergies}. `;
        if (mi.conditions) msg += `Conditions: ${mi.conditions}. `;
        if (mi.emergency_notes) msg += `Emergency notes: ${mi.emergency_notes}. `;
        if (!mi.blood_type && !mi.allergies && !mi.conditions) {
            msg += 'No medical details have been added yet. Ask your guardian to add them.';
        }
        speak(msg, true);
    } catch (e) { speak('Could not load medical information.', true); }
};

// ===== GEOFENCE SAFE ZONE MONITOR =====
const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3; // Earth radius in meters
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

let geofenceConfig = null;
let lastGeofenceAlert = 0;

const initGeofenceMonitor = () => {
    // Fetch geofence config once, then check location every 30s
    const loadConfig = async () => {
        try {
            const res = await fetch('/api/geofence');
            if (res.ok) geofenceConfig = await res.json();
        } catch (e) { /* offline — skip */ }
    };

    const checkGeofence = () => {
        if (!geofenceConfig || !geofenceConfig.enabled) return;
        if (!geofenceConfig.lat || !geofenceConfig.lon) return;
        const loc = window.lastKnownLocation;
        if (!loc || !loc.latitude) return;

        const dist = haversine(loc.latitude, loc.longitude, geofenceConfig.lat, geofenceConfig.lon);
        const radius = geofenceConfig.radius || 500;

        if (dist > radius) {
            const now = Date.now();
            // Cooldown: 5 minutes between geofence alerts
            if (now - lastGeofenceAlert < 300000) return;
            lastGeofenceAlert = now;

            const distRounded = Math.round(dist);
            speak(`Warning. You have left your safe zone.`, true);
            showAIBubble(`📍 Left safe zone`);
            if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);

            // Alert the guardian dashboard
            fetch('/api/geofence-alert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lat: loc.latitude, lon: loc.longitude,
                    distance: distRounded,
                    label: geofenceConfig.label || 'Safe Zone'
                })
            }).catch(() => {});
        }
    };

    loadConfig();
    setInterval(() => { loadConfig(); checkGeofence(); }, 30000);
};

// ===== DOCUMENT / PDF READER =====
const readDocument = async () => {
    speak('Hold the document steady in front of camera. Reading in 2 seconds.', true);
    await new Promise(r => setTimeout(r, 2000));
    captureAndDescribe('Read every word of text visible in this image in order, left to right, top to bottom. Include all numbers, headings, and labels. Format naturally for someone listening, not reading. If this is a form, read each field and its value.');
};

// ===== TEXT SIMPLIFICATION (DYSLEXIA) =====
const simplifyText = async () => {
    speak('What text should I simplify? Point camera at it.', true);
    await new Promise(r => setTimeout(r, 2000));
    captureAndDescribe('Read the text in this image. Then rewrite it in the simplest possible language. Use short sentences. Maximum 8 words per sentence. Avoid complex words. Explain any technical terms simply. Format: First say the original, then say In simple words followed by the simplified version.');
};

// ===== CURRENCY DETECTION =====
const detectCurrency = async () => {
    speak('Hold the currency note flat in front of camera. Hold steady.', true);
    await new Promise(r => setTimeout(r, 2000));
    if (isDescribing) return;
    isDescribing = true;
    const btn = document.getElementById('capture-btn');
    if (btn) btn.classList.add('loading');
    try {
        const video = document.getElementById('camera-feed');
        if (!video || !video.videoWidth) { speak('Camera not ready. Try again.', true); isDescribing = false; return; }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        const imageB64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
        speak('Analyzing...', false);
        if (navigator.vibrate) navigator.vibrate(100);
        const res = await fetch('/api/vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageB64, language: lang, memory: '',
                query: 'Look carefully at this image for any Indian currency note (Rupees). Identify the denomination: 1, 2, 5, 10, 20, 50, 100, 200, 500, or 2000 rupees. Look for large numbers printed on note. Check front AND back indicators. Reply in ONE sentence only. Example: This is a 500 rupee note.' })
        });
        const data = await res.json();
        const result = data.description || 'Could not detect. Try again.';
        speak(result, true); showAIBubble('💰 ' + result);
        if (navigator.vibrate) {
            if (result.includes('2000')) navigator.vibrate([500, 100, 500, 100, 500, 100, 500]);
            else if (result.includes('500')) navigator.vibrate([300, 100, 300, 100, 300]);
            else if (result.includes('200') || result.includes('100')) navigator.vibrate([200, 100, 200]);
            else if (result.includes('50') || result.includes('20') || result.includes('10')) navigator.vibrate([200]);
        }
    } catch (e) {
        if (!navigator.onLine) speak('Currency detection needs internet. You are offline.', true);
        else speak('Detection failed. Please try again.', true);
    }
    isDescribing = false;
    if (btn) btn.classList.remove('loading');
};

// ===== DYSLEXIA MODE =====
let dyslexiaModeActive = false;
const activateDyslexiaMode = () => {
    if (dyslexiaModeActive) return;
    dyslexiaModeActive = true;
    document.body.style.fontSize = '20px';
    document.body.style.lineHeight = '1.8';
    document.body.style.background = '#000';
    document.body.style.color = '#FFFF00';
    // Override speak to use slower rate
    const origSpeak = speak;
    window._dyslexiaSpeak = (text, force) => {
        if (!('speechSynthesis' in window) || !text) return;
        if (force) window.speechSynthesis.cancel();
        const msg = new SpeechSynthesisUtterance(text);
        msg.rate = 0.75; msg.pitch = 1.0;
        const voices = window.speechSynthesis.getVoices();
        const lc = lang.split('-')[0];
        const match = voices.find(v => v.lang.startsWith(lc));
        if (match) msg.voice = match;
        window.speechSynthesis.speak(msg);
    };
    speak('Dyslexia mode activated. Text is larger. Speech is slower.', true);
};

// ===== FALL DETECTION ENGINE =====
const FallDetection = {
    FREEFALL_THRESHOLD: 3.0,   // Below this = freefall (near 0g)
    IMPACT_THRESHOLD: 25.0,    // Above this = hard impact (>2.5g)
    COOLDOWN_MS: 60000,        // 60s cooldown between fall alerts
    COUNTDOWN_SECONDS: 15,     // Seconds before auto-SOS
    bufferSize: 20,            // Track last 20 readings (~1s at 50Hz)
    recentReadings: [],
    freefallDetected: false,
    freefallTime: 0,

    // Called on every accelerometer reading
    analyze(mag) {
        const now = Date.now();
        this.recentReadings.push({ mag, time: now });
        if (this.recentReadings.length > this.bufferSize) this.recentReadings.shift();

        // Phase 1: Detect freefall (very low acceleration = phone dropping)
        if (mag < this.FREEFALL_THRESHOLD && !this.freefallDetected) {
            this.freefallDetected = true;
            this.freefallTime = now;
            return false;
        }

        // Phase 2: After freefall, look for impact within 2 seconds
        if (this.freefallDetected) {
            // Timeout: if no impact within 2s, reset
            if (now - this.freefallTime > 2000) {
                this.freefallDetected = false;
                return false;
            }
            // Impact detected!
            if (mag > this.IMPACT_THRESHOLD) {
                this.freefallDetected = false;
                // Cooldown check
                if (now - lastFallAlertTime < this.COOLDOWN_MS) return false;
                lastFallAlertTime = now;
                return true; // FALL DETECTED
            }
        }

        return false;
    },

    reset() {
        this.freefallDetected = false;
        this.recentReadings = [];
    }
};

// Show the "Are you okay?" overlay
const showFallAlert = () => {
    fallDetected = true;
    fallCountdownValue = FallDetection.COUNTDOWN_SECONDS;

    // Heavy vibration pattern to get attention
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500, 200, 500]);

    // Speak urgently
    speak('Fall detected! Are you okay? Say I am okay, or I will send an emergency alert in 15 seconds.', true);

    // Create overlay
    let overlay = document.getElementById('fall-alert-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'fall-alert-overlay';
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
        <div class="fall-alert-content">
            <div class="fall-alert-icon">⚠️</div>
            <h2 class="fall-alert-title">Fall Detected!</h2>
            <p class="fall-alert-subtitle">Are you okay?</p>
            <div class="fall-alert-countdown" id="fall-countdown">${fallCountdownValue}</div>
            <p class="fall-alert-timer-label">seconds until auto-SOS</p>
            <div class="fall-alert-buttons">
                <button class="fall-btn-ok" id="fall-btn-ok" aria-label="I am okay, cancel SOS">I'm Okay ✓</button>
                <button class="fall-btn-sos" id="fall-btn-sos" aria-label="Send SOS now">Send SOS Now 🚨</button>
            </div>
            <p class="fall-alert-hint">Say <strong>"I'm okay"</strong> or tap the button</p>
        </div>
    `;
    overlay.classList.add('visible');

    // Button handlers
    document.getElementById('fall-btn-ok')?.addEventListener('click', cancelFallAlert);
    document.getElementById('fall-btn-sos')?.addEventListener('click', () => {
        cancelFallAlert();
        triggerFallSOS();
    });

    // Start countdown
    fallCountdownTimer = setInterval(() => {
        fallCountdownValue--;
        const el = document.getElementById('fall-countdown');
        if (el) el.textContent = fallCountdownValue;

        // Periodic reminders
        if (fallCountdownValue === 10) {
            speak('10 seconds. Say I am okay to cancel.', true);
            if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
        } else if (fallCountdownValue === 5) {
            speak('5 seconds!', true);
            if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
        }

        if (fallCountdownValue <= 0) {
            clearInterval(fallCountdownTimer);
            fallCountdownTimer = null;
            // No response — trigger SOS
            triggerFallSOS();
        }
    }, 1000);
};

// Cancel the fall alert (user is okay)
const cancelFallAlert = () => {
    fallDetected = false;
    if (fallCountdownTimer) {
        clearInterval(fallCountdownTimer);
        fallCountdownTimer = null;
    }
    const overlay = document.getElementById('fall-alert-overlay');
    if (overlay) overlay.classList.remove('visible');
    speak('Good. Alert cancelled. Stay safe.', true);
    showAIBubble('✅ Fall alert cancelled — user is okay');
    if (navigator.vibrate) navigator.vibrate(100); // gentle confirmation

    // Log the cancelled fall event
    fetch('/api/fall-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'cancelled',
            lat: window.lastKnownLocation?.latitude || null,
            lon: window.lastKnownLocation?.longitude || null
        })
    }).catch(() => {});
};

// Trigger SOS specifically for fall detection
const triggerFallSOS = () => {
    fallDetected = false;
    if (fallCountdownTimer) {
        clearInterval(fallCountdownTimer);
        fallCountdownTimer = null;
    }
    const overlay = document.getElementById('fall-alert-overlay');
    if (overlay) overlay.classList.remove('visible');

    speak('Sending emergency alert. Fall detected. Help is on the way.', true);
    showAIBubble('🚨 FALL SOS TRIGGERED — Alert sent to guardian');

    // Log the fall-triggered SOS
    fetch('/api/fall-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'triggered',
            lat: window.lastKnownLocation?.latitude || null,
            lon: window.lastKnownLocation?.longitude || null
        })
    }).catch(() => {});

    // Now trigger the main SOS (with photo + location)
    triggerSOS();
};

// ===== TRIGGER SOS (reusable) =====
const triggerSOS = () => {
    speak('Sending emergency alert now!', true);
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
    
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        window.lastKnownLocation = {latitude: lat, longitude: lon};
        
        // Capture current camera frame
        let photoB64 = undefined;
        const video = document.getElementById('camera-feed');
        if (video && video.videoWidth) {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          photoB64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
        }

        // NOW send SOS with real coords + medical info for first responders
        fetch('/api/sos', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({latitude: lat, longitude: lon, phone: guardianPhone || undefined, photo: photoB64, medical_info: cachedMedicalInfo || undefined})
        });
      },
      (err) => {
        // GPS failed — send with last known or default
        const loc = window.lastKnownLocation || 
                    {latitude: '22.7196', longitude: '75.8577'};
        fetch('/api/sos', { method:'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({...loc, phone: guardianPhone || undefined})
        });
      },
      {enableHighAccuracy: true, timeout: 5000}
    );
};

// ===== SPEECH (barge-in enabled, does NOT stop recognition) =====
const speak = (text, force = false) => {
    if (!('speechSynthesis' in window) || !text) return;
    
    // If it's already speaking:
    // - If force = true (e.g. URGENT STOP), cancel current and speak immediately.
    // - If force = false, simply DROP this message to avoid queuing stale info or annoying the user.
    if (window.speechSynthesis.speaking) {
        if (force) {
            window.speechSynthesis.cancel();
        } else {
            return; // Drop non-urgent message, don't queue
        }
    }
    
    const msg = new SpeechSynthesisUtterance(text);
    msg.rate = 1.0; // Normal rate, sounds more conversational
    const voices = window.speechSynthesis.getVoices();
    const lc = lang.split('-')[0];
    const match = voices.find(v => v.lang.startsWith(lc));
    if (match) msg.voice = match;
    window.speechSynthesis.speak(msg);
};

const showAIBubble = (text) => {
    const bubble = document.getElementById('ai-bubble');
    if (!bubble) return;
    const body = bubble.querySelector('.body');
    if (body) body.textContent = text;
    bubble.classList.add('visible');
};

// ===== RECOGNITION (with barge-in support) =====
const setupRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = false; // Keep false to avoid partial triggers
    recognition.lang = lang;
    recognition.onresult = (e) => {
        const transcript = e.results[e.results.length - 1][0].transcript.trim();
        
        // Prevent self-triggering (panicking): If Sathi is currently speaking, 
        // the microphone is likely picking up the device's own speakers. 
        // We ignore the transcript to prevent infinite loops.
        if (window.speechSynthesis.speaking) {
            return;
        }

        // Track user activity for silence timer
        lastUserCommandTime = Date.now();
        if (isCaptionMode) {
            transcriptBuffer += ' ' + transcript;
            const el = document.getElementById('caption-overlay');
            if (el) { el.classList.add('visible'); el.textContent = transcriptBuffer.slice(-300); }
        }
        routeVoiceCommand(transcript);
    };
    // Auto-restart recognition if it stops (browser cuts it off periodically)
    recognition.onend = () => {
        if (recognitionActive) {
            recognition.lang = lang;
            try { recognition.start(); } catch (e) { }
        }
    };
};
const startRecognition = () => {
    if (!recognition) return;
    recognitionActive = true; recognition.lang = lang;
    try { recognition.start(); } catch (e) { }
    updateMicUI(true);
};
const stopRecognition = () => {
    recognitionActive = false;
    try { recognition?.stop(); } catch (e) { }
    updateMicUI(false);
};
const updateMicUI = (active) => {
    const d = document.getElementById('mic-dot');
    const l = document.getElementById('mic-label');
    if (d) d.className = active ? 'mic-dot' : 'mic-dot paused';
    if (l) l.textContent = active ? 'LISTENING' : 'PAUSED';

    const globalMic = document.getElementById('global-mic-indicator');
    if (globalMic) {
        if (active) {
            globalMic.classList.remove('-translate-y-[200%]', 'opacity-0', 'pointer-events-none');
            globalMic.classList.add('translate-y-0', 'opacity-100');
        } else {
            globalMic.classList.add('-translate-y-[200%]', 'opacity-0', 'pointer-events-none');
            globalMic.classList.remove('translate-y-0', 'opacity-100');
        }
    }
};

// ===== VOICE ROUTING =====
const routeVoiceCommand = async (transcript) => {
    const t = transcript.toLowerCase().trim();

    if (appState === 'login') {
        if (['user', 'me', 'i am the user', 'for me'].some(k => t.includes(k))) {
            const btn = document.getElementById('lc-user');
            if (btn) btn.click();
        } else if (['guardian', 'someone', 'for someone', 'i am a guardian'].some(k => t.includes(k))) {
            const btn = document.getElementById('lc-guardian');
            if (btn) btn.click();
        } else if (['continue', 'next', 'go', 'start'].some(k => t.includes(k))) {
            const btn = document.getElementById('login-continue');
            if (btn && !btn.disabled) btn.click();
        }
        return;
    }
    
    if (appState === 'onboarding') {
        if (onboardingStep === 0) {
            if (['me', 'for me', 'user'].some(k => t.includes(k))) {
                const btn = document.getElementById('card-self');
                if (btn) btn.click();
            } else if (['someone', 'for someone', 'guardian'].some(k => t.includes(k))) {
                const btn = document.getElementById('card-guardian');
                if (btn) btn.click();
            } else if (['next', 'continue', 'go'].some(k => t.includes(k))) {
                const btn = document.getElementById('next-0');
                if (btn && !btn.disabled) btn.click();
            }
        } else if (onboardingStep === 1) {
            if (['visual', 'vision', 'blind', 'see'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-dis="visual"]');
                if (btn) btn.click();
            } else if (['hearing', 'deaf', 'audio'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-dis="hearing"]');
                if (btn) btn.click();
            } else if (['dyslexia', 'reading', 'read'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-dis="dyslexia"]');
                if (btn) btn.click();
            } else if (['motor', 'movement', 'wheelchair', 'walk'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-dis="motor"]');
                if (btn) btn.click();
            } else if (['elderly', 'old', 'age', 'senior'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-dis="elderly"]');
                if (btn) btn.click();
            } else if (['other', 'something else'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-dis="other"]');
                if (btn) btn.click();
            }
            if (['next', 'continue', 'go'].some(k => t.includes(k))) {
                const btn = document.getElementById('next-1');
                if (btn && !btn.disabled) btn.click();
            } else if (['back', 'previous'].some(k => t.includes(k))) {
                const btn = document.getElementById('back-1');
                if (btn) btn.click();
            }
        } else if (onboardingStep === 2) {
            if (t.includes('name is ')) {
                const nameMatch = t.match(/name is (.+)/);
                if (nameMatch) {
                    const input = document.getElementById('g-name');
                    if (input) { input.value = nameMatch[1].trim(); input.dispatchEvent(new Event('input')); speak('Name set to ' + nameMatch[1], false); }
                }
            } else if (t.includes('number is ') || t.includes('phone is ')) {
                const phoneMatch = t.match(/(number is|phone is) (.+)/);
                if (phoneMatch) {
                    const phoneRaw = phoneMatch[2].replace(/\D/g, '');
                    const input = document.getElementById('g-phone');
                    if (input && phoneRaw) { input.value = phoneRaw; input.dispatchEvent(new Event('input')); speak('Phone set to ' + phoneRaw.split('').join(' '), false); }
                }
            }
            if (['next', 'continue', 'go'].some(k => t.includes(k))) {
                const btn = document.getElementById('next-2');
                if (btn && !btn.disabled) btn.click();
            } else if (['back', 'previous'].some(k => t.includes(k))) {
                const btn = document.getElementById('back-2');
                if (btn) btn.click();
            }
        } else if (onboardingStep === 3) {
            if (['english'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-lang="en-US"]');
                if (btn) btn.click();
            } else if (['hindi', 'hind'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-lang="hi-IN"]');
                if (btn) btn.click();
            } else if (['marathi'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-lang="mr-IN"]');
                if (btn) btn.click();
            } else if (['tamil'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-lang="ta-IN"]');
                if (btn) btn.click();
            } else if (['bengali', 'bangla'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-lang="bn-IN"]');
                if (btn) btn.click();
            } else if (['gujarati'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-lang="gu-IN"]');
                if (btn) btn.click();
            } else if (['urdu'].some(k => t.includes(k))) {
                const btn = document.querySelector('[data-lang="ur-IN"]');
                if (btn) btn.click();
            }
            if (['next', 'continue', 'go'].some(k => t.includes(k))) {
                const btn = document.getElementById('next-3');
                if (btn) btn.click();
            } else if (['back', 'previous'].some(k => t.includes(k))) {
                const btn = document.getElementById('back-3');
                if (btn) btn.click();
            }
        }
        return;
    }

    // FALL ALERT: "I'm okay" cancellation (must come before SOS check)
    if (fallDetected && ['okay', 'ok', 'fine', 'i\'m okay', 'i\'m fine', 'i am okay', 'i am fine', 'cancel', 'theek', 'theek hoon', 'ठीक', 'ठीक हूं'].some(k => t.includes(k))) {
        cancelFallAlert();
        return;
    }

    // FALL ALERT: "Help" during fall alert triggers immediate SOS
    if (fallDetected && ['help', 'sos', 'emergency', 'bachao', 'बचाओ', 'madad', 'मदद'].some(k => t.includes(k))) {
        triggerFallSOS();
        return;
    }

    // SOS
    if (['help', 'sos', 'emergency', 'bachao', 'बचाओ', 'madad', 'मदद'].some(k => t.includes(k))) {
        speak('Sending emergency alert now!', true);
        const loc = window.lastKnownLocation || {};
        fetch('/api/sos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ latitude: loc.latitude || '28.6139', longitude: loc.longitude || '77.2090', phone: guardianPhone || undefined }) });
        return;
    }

    // READ TEXT
    if (['read this', 'read text', 'read sign', 'what does it say', 'padho', 'पढ़ो', 'kya likha', 'read label', 'read menu', 'read medicine', 'read currency', 'read note'].some(k => t.includes(k))) {
        speak('Reading text for you. Hold steady.', true);
        captureAndDescribe('Read all text, numbers, labels, signs, and writing visible in this image. If it is a currency note, identify the denomination.');
        return;
    }

    // FLASHLIGHT
    if (['flashlight on', 'torch on', 'light on', 'torch chalu'].some(k => t.includes(k))) { toggleFlashlight(true); return; }
    if (['flashlight off', 'torch off', 'light off', 'torch band'].some(k => t.includes(k))) { toggleFlashlight(false); return; }

    // CAPTIONS
    if (['start caption', 'caption on', 'sunao', 'subtitle'].some(k => t.includes(k))) { isCaptionMode = true; transcriptBuffer = ''; speak('Captions started'); return; }

    // STOP
    if (['stop', 'ruko', 'bas', 'pause', 'quiet', 'band', 'चुप', 'बस', 'बंद'].some(k => t.includes(k))) {
        window.speechSynthesis.cancel(); stopAutoDescribe(); ProximityBeep.stop(); isCaptionMode = false;
        const el = document.getElementById('caption-overlay'); if (el) el.classList.remove('visible'); return;
    }

    // LANGUAGE
    if (['change language', 'bhasha badlo', 'switch language'].some(k => t.includes(k))) {
        let nl = null;
        if (t.includes('hindi')) nl = 'hi-IN'; else if (t.includes('english')) nl = 'en-US';
        else if (t.includes('marathi')) nl = 'mr-IN'; else if (t.includes('tamil')) nl = 'ta-IN';
        else if (t.includes('bengali') || t.includes('bangla')) nl = 'bn-IN';
        else if (t.includes('gujarati')) nl = 'gu-IN'; else if (t.includes('urdu')) nl = 'ur-IN';
        if (nl) { lang = nl; if (recognition) recognition.lang = lang; speak('Language changed.', true); showAIBubble(`🌐 Language → ${nl}`); }
        else speak('Say: change language to Hindi, English, Marathi, Tamil, Bengali, Gujarati, or Urdu.', true);
        return;
    }

    // NAVIGATION
    if (['saathi classroom', 'classroom', 'go to classroom'].some(k => t.includes(k))) {
        speak('Opening classroom mode.', true);
        window.location.href = '/classroom';
        return;
    }
    if (['go back', 'piche chalo', 'back', 'wapas'].some(k => t.includes(k))) {
        speak('Going back.', true);
        window.history.back();
        return;
    }

    // HELP — complete command list
    if (['what can you do', 'help me', 'features', 'commands'].some(k => t.includes(k))) {
        speak('Safety commands: check path, check stairs, check ground, check door, is it safe. Navigation: describe, where am I, look around, any people. Actions: SOS, help, read this, currency, flashlight, zoom. Tap screen twice for instant safety scan. Triple-tap for emergency SOS.', true);
        return;
    }

    // WHERE WAS I / SCENE MEMORY RECALL
    if (['where was i', 'what did i see', 'remember', 'kya dekha', 'yaad', 'recall'].some(k => t.includes(k))) {
        if (SceneMemory.memories.length === 0) { speak('I have no memories yet. Walk around and I will remember.', true); return; }
        const last = SceneMemory.memories[SceneMemory.memories.length - 1];
        const ago = Math.round((Date.now() - last.timestamp) / 60000);
        speak(`${ago} minutes ago, I saw: ${last.description}`, true);
        showAIBubble(`🧠 ${ago}m ago: ${last.description}`);
        return;
    }

    // SAFETY SCAN COMMANDS (Edge cases for blind users)
    if (['check path', 'is it safe', 'safe to walk', 'raasta dekho', 'raasta theek hai', 'scan ahead', 'check ahead'].some(k => t.includes(k))) {
        speak('Checking your path for safety.', true);
        captureAndDescribe('SAFETY CHECK: Look very carefully at the walking path ahead. Is there a wall, stairs, curb, drop-off, hole, wet floor, obstacle, or any danger? If safe, say clear path. If not, describe the exact danger and which direction to go to avoid it.');
        return;
    }
    if (["what's around me", 'surroundings', 'aas paas', 'around me', 'look around', 'scan room', 'kya hai idhar'].some(k => t.includes(k))) {
        speak('Scanning your surroundings.', true);
        captureAndDescribe('Describe everything around this person in all directions. Mention: exits, doors, furniture, people, obstacles, floor type, lighting. Be specific about left, right, ahead, and behind if visible.');
        return;
    }
    if (['check ground', 'ground', 'floor', 'zameen', 'check floor', 'surface'].some(k => t.includes(k))) {
        speak('Checking the ground.', true);
        captureAndDescribe('Focus on the floor/ground surface ahead. Is it level, sloped, wet, uneven, or damaged? Are there steps, curbs, cracks, puddles, cables, or any tripping hazards? Describe precisely.');
        return;
    }
    if (['check stairs', 'stairs', 'steps', 'seedhi', 'seeji', 'any stairs', 'is there stairs'].some(k => t.includes(k))) {
        speak('Checking for stairs.', true);
        captureAndDescribe('Are there any stairs, steps, ramps, or elevation changes visible? If yes, are they going UP or DOWN? How many steps approximately? Is there a handrail?');
        return;
    }
    if (['is there a door', 'door', 'darwaza', 'check door', 'any door'].some(k => t.includes(k))) {
        speak('Looking for doors.', true);
        captureAndDescribe('Is there a door visible? Is it open, closed, or partially open? Is it a glass door, wooden door, or automatic door? Where is the handle? Which direction does it open?');
        return;
    }
    if (['where am i', 'location', 'kahan hoon', 'place', 'which room', 'konsa kamra'].some(k => t.includes(k))) {
        speak('Identifying your location.', true);
        captureAndDescribe('What room or place is this? Identify: is this indoors or outdoors? What type of room (kitchen, bathroom, office, corridor, street)? Mention landmarks, signs, or identifiers visible.');
        return;
    }
    if (['any people', 'people', 'log', 'koi hai', 'is anyone there', 'is someone there', 'who is there'].some(k => t.includes(k))) {
        speak('Looking for people.', true);
        captureAndDescribe('Are there any people visible? How many? Where are they relative to me (ahead, left, right)? Are they standing, sitting, moving toward me or away?');
        return;
    }

    // DESCRIBE (explicit trigger)
    if (['describe', 'what do you see', 'kya dikh raha', 'batao', 'dekhao', 'start', 'resume', 'chalu', 'shuru'].some(k => t.includes(k))) {
        captureAndDescribe();
        return;
    }

    // ZOOM
    if (['zoom in', 'bada karo', 'zoom karo'].some(k => t.includes(k))) { setZoom(0.7); return; }
    if (['zoom out', 'chhota karo', 'door karo'].some(k => t.includes(k))) { setZoom(0.2); return; }
    if (['zoom normal', 'normal karo', 'normal zoom'].some(k => t.includes(k))) { setZoom(0.3); return; }

    // BATTERY
    if (['battery', 'battery kitni', 'charge', 'charging'].some(k => t.includes(k))) { checkBattery(); return; }

    // NETWORK
    if (['network', 'internet', 'connection', 'signal', 'wifi'].some(k => t.includes(k))) { checkNetwork(); return; }

    // WHATSAPP SOS
    if (['whatsapp', 'whatsapp karo', 'message karo', 'whatsapp bhejo'].some(k => t.includes(k))) { sendWhatsAppSOS(); return; }

    // TIME / DATE
    if (['time', 'time kya hai', 'kitne baje', 'date', 'din kya hai', 'what time'].some(k => t.includes(k))) { tellTime(); return; }

    // VOLUME
    if (['volume up', 'awaaz badhao', 'louder'].some(k => t.includes(k))) { setVolume(1.0); return; }
    if (['volume down', 'awaaz kam karo', 'softer', 'quiet'].some(k => t.includes(k))) { setVolume(0.3); return; }

    // DOCUMENT READER
    if (['read document', 'document padho', 'read paper', 'read letter', 'padhao', 'read form', 'read prescription'].some(k => t.includes(k))) { readDocument(); return; }

    // TEXT SIMPLIFICATION
    if (['simplify', 'simple karo', 'easy language', 'dyslexia mode', 'simple batao'].some(k => t.includes(k))) { simplifyText(); return; }

    // CURRENCY DETECTION
    if (['currency', 'note', 'paisa', 'note dekho', 'kitne ka note', 'note kitne ka hai', 'paise dekho', 'money', 'rupee', 'cash'].some(k => t.includes(k))) { detectCurrency(); return; }

    // CARE PROFILE VOICE COMMANDS
    if (['my medicines', 'meri dawai', 'medicines list', 'dawai batao', 'what medicines', 'medicine list'].some(k => t.includes(k))) { tellMyMedicines(); return; }
    if (['my medical info', 'medical info', 'allergy', 'allergies', 'blood type', 'meri allergy', 'mera blood group', 'medical details'].some(k => t.includes(k))) { tellMyMedicalInfo(); return; }
    if (['read medicine', 'medicine padho', 'read prescription', 'prescription padho', 'dawai padho'].some(k => t.includes(k))) {
        speak('Hold the medicine label in front of the camera. Reading in 2 seconds.', true);
        await new Promise(r => setTimeout(r, 2000));
        captureAndDescribe('Read the medicine label in this image. State clearly: medicine name, dosage instructions, expiry date, and any warnings. Use simple language for someone who is visually impaired.');
        return;
    }

    // DYSLEXIA MODE
    if (['dyslexia mode on', 'dyslexia on', 'dyslexia chalu'].some(k => t.includes(k))) { activateDyslexiaMode(); return; }
    if (['normal mode', 'normal karo'].some(k => t.includes(k))) { location.reload(); return; }

    // DEFAULT: treat as question about surroundings
    captureAndDescribe(transcript);
};

// ===== CAPTURE + DESCRIBE =====
const captureGuideZoneFrame = (video) => {
    const c = document.createElement('canvas');
    const vw = video.videoWidth, vh = video.videoHeight;
    const zoneX = vw * 0.05, zoneY = vh * 0.1, zoneW = vw * 0.9, zoneH = vh * 0.85;
    c.width = zoneW; c.height = zoneH;
    const ctx = c.getContext('2d');
    ctx.drawImage(video, zoneX, zoneY, zoneW, zoneH, 0, 0, zoneW, zoneH);
    return c.toDataURL('image/jpeg', 0.7).split(',')[1];
};

const captureAndDescribe = async (query = null) => {
    if (isDescribing) return;
    isDescribing = true;
    const btn = document.getElementById('capture-btn');
    if (btn) btn.classList.add('loading');
    try {
        const video = document.getElementById('camera-feed');
        if (!video || !video.videoWidth) { isDescribing = false; if (btn) btn.classList.remove('loading'); return; }
        const imageB64 = captureGuideZoneFrame(video);
        const memoryContext = SceneMemory.getContext();
        const systemPrompt = `You are SATHI, AI safety eyes for a visually impaired person. PRIORITY: dangers first (walls, stairs, obstacles), then navigation, then context. Max 2 sentences. First sentence = most important safety info. NEVER estimate distance or use words like near, far, close, meters, or feet.${memoryContext}`;
        const messages = [
            { role: "system", content: systemPrompt },
            ...conversationHistory.slice(-12),
            { role: "user", content: query || "What do you see?" }
        ];
        const res = await fetch('/api/vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageB64, language: lang, query: query, memory: memoryContext, messages: messages })
        });
        const data = await res.json();
        const desc = data.description || 'Could not analyze the scene.';
        conversationHistory.push(
            { role: "user", content: query || "describe" },
            { role: "assistant", content: desc }
        );
        if (conversationHistory.length > 12) {
            conversationHistory = conversationHistory.slice(-12);
        }
        if (desc !== lastDescription) {
            lastDescription = desc;
            if (dyslexiaModeActive && window._dyslexiaSpeak) window._dyslexiaSpeak(desc, true);
            else speak(desc, true);
            showAIBubble(desc);
            SceneMemory.add(desc);
        }
        updateConvFeed();
        showQuickChips();
    } catch (e) {
        console.error('Vision error:', e);
        if (!navigator.onLine) speak('No internet. I can still detect nearby objects using the camera.', true);
        else speak('Connection error. Please try again.', true);
    }
    isDescribing = false;
    if (btn) btn.classList.remove('loading');
};

// ===== MOTION-TRIGGERED DESCRIBE (replaces timer-based auto-describe) =====
const initMotionDescribe = () => {
    if (typeof DeviceMotionEvent === 'undefined') return;

    // Request permission on iOS 13+
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission().then(s => {
            if (s === 'granted') window.addEventListener('devicemotion', handleMotion);
        }).catch(() => {});
    } else {
        window.addEventListener('devicemotion', handleMotion);
    }
};

const handleMotion = (e) => {
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;
    const mag = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2);

    // ===== FALL DETECTION CHECK =====
    if (!fallDetected && appState === 'camera') {
        const isFall = FallDetection.analyze(mag);
        if (isFall) {
            showFallAlert();
            return; // Skip motion-describe on fall event
        }
    }

    motionBuffer.push(mag);
    if (motionBuffer.length > 10) motionBuffer.shift();
    const avg = motionBuffer.reduce((a, b) => a + b, 0) / motionBuffer.length;
    const now = Date.now();
    // Significant movement AND enough time since last describe AND enough silence from user
    // Reduced to 10s for proactive safety to detect walls faster
    if (avg > 12 && (now - lastDescribeTime) > 10000 && (now - lastUserCommandTime) > 8000) {
        lastDescribeTime = now;
        captureAndDescribe();
    }
};

// Legacy compatibility stubs (referenced elsewhere)
const stopAutoDescribe = () => {
    ProximityBeep.stop();
    const s = document.getElementById('hud-status'); if (s) s.textContent = 'Paused';
};

// ===== CAMERA HUD =====
const goToCameraHUD = async () => {
    app.innerHTML = `
    <div class="relative w-full h-full bg-primary overflow-hidden">
        <video id="camera-feed" class="absolute top-0 left-0 w-full h-full object-cover" autoplay playsinline muted></video>
        <canvas id="guide-canvas" class="absolute top-0 left-0 w-full h-full pointer-events-none"></canvas>
        <canvas id="detect-canvas" class="absolute top-0 left-0 w-full h-full pointer-events-none"></canvas>
        
        <div id="offline-badge" style="display:none;" class="absolute top-4 right-4 bg-error text-surface px-3 py-1 text-xs font-bold border-2 border-primary shadow-brutal z-[9999]">OFFLINE</div>
        <div class="rt-indicator" aria-label="Live camera active"><span class="rt-dot"></span>LIVE</div>
        
        <!-- Top Bar -->
        <div class="absolute top-0 left-0 w-full p-4 flex justify-between items-start z-10">
            <div>
                <div class="font-newsreader italic text-2xl font-bold text-surface bg-primary px-2 border-2 border-surface inline-block shadow-brutal">SATHI</div>
                <div class="font-worksans text-xs font-bold text-primary bg-surface px-2 py-1 border-2 border-primary shadow-brutal mt-2" id="hud-status">Initializing...</div>
            </div>
            <button class="sos-btn bg-error text-surface font-bold px-4 py-2 border-2 border-primary shadow-brutal hover:-translate-y-1 active:translate-y-1 active:shadow-none transition-all" id="sos-btn" aria-label="Emergency SOS">SOS</button>
        </div>
        
        <!-- Memory Badge -->
        <div class="absolute top-24 left-4 bg-surface text-primary border-2 border-primary font-bold px-2 py-1 text-xs shadow-brutal transition-all" id="memory-badge">🧠 MEMORY: 0</div>
        
        <!-- Bottom Controls -->
        <div class="absolute bottom-20 left-0 w-full p-4 flex flex-col gap-4 z-10" id="hud-bottom-area">
            <div class="conv-feed" id="conv-feed" aria-label="Conversation history" role="log" aria-live="polite"></div>
            <div class="ai-bubble hidden bg-surface border-2 border-primary shadow-brutal p-3 max-w-[80%] self-start transition-all" id="ai-bubble">
                <span class="block text-xs font-bold uppercase mb-1">SATHI</span>
                <span class="body font-newsreader text-sm font-medium">Initializing camera...</span>
            </div>
            <div class="caption-overlay hidden bg-primary text-surface p-2 border-2 border-surface font-worksans text-sm shadow-brutal" id="caption-overlay"></div>
            
            <div class="flex justify-between items-end">
                <div class="mic-indicator flex items-center gap-2 bg-surface border-2 border-primary px-3 py-2 shadow-brutal cursor-pointer hover:-translate-y-1 active:translate-y-0 transition-all" id="mic-indicator">
                    <div class="w-3 h-3 bg-error border border-primary animate-pulse" id="mic-dot"></div>
                    <span class="font-bold text-xs" id="mic-label">LISTENING</span>
                </div>
                
                <div class="flex gap-4 items-end">
                    <button class="capture-btn w-12 h-12 bg-warning border-2 border-primary shadow-brutal flex items-center justify-center text-xl hover:-translate-y-1 active:translate-y-1 active:shadow-none transition-all" id="currency-btn" aria-label="Detect currency">💰</button>
                    <button class="capture-btn w-16 h-16 bg-surface border-4 border-primary shadow-brutal flex items-center justify-center text-3xl hover:-translate-y-1 active:translate-y-1 active:shadow-none transition-all" id="capture-btn" aria-label="Describe scene">👁️</button>
                </div>
            </div>
            <div class="sathi-text-input">
                <input type="text" id="sathi-text-field" placeholder="Type a question…" aria-label="Type a question for SATHI">
                <button id="sathi-text-send" aria-label="Send question">➤</button>
            </div>
        </div>
        
        <!-- Bottom Nav -->
        <nav class="absolute bottom-0 left-0 w-full bg-surface border-t-4 border-primary flex justify-around items-center z-20 h-16">
            <a href="/" class="flex flex-col items-center justify-center h-full w-full border-r-4 border-primary bg-primary text-surface">
                <span class="text-xl">👁️</span>
                <span class="text-[10px] font-bold mt-1 uppercase tracking-wider">Vision</span>
            </a>
            <a href="/classroom" class="flex flex-col items-center justify-center h-full w-full border-r-4 border-primary bg-surface text-primary hover:bg-gray-100 transition-colors">
                <span class="text-xl">🎓</span>
                <span class="text-[10px] font-bold mt-1 uppercase tracking-wider">Classroom</span>
            </a>
            <a href="/dashboard" class="flex flex-col items-center justify-center h-full w-full bg-surface text-primary hover:bg-gray-100 transition-colors">
                <span class="text-xl">🛡️</span>
                <span class="text-[10px] font-bold mt-1 uppercase tracking-wider">Guardian</span>
            </a>
        </nav>
    </div>`;

    // Camera
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        const video = document.getElementById('camera-feed'); video.srcObject = stream;
        await video.play();
        const gc = document.getElementById('guide-canvas'); gc.width = video.clientWidth; gc.height = video.clientHeight;
        const dc = document.getElementById('detect-canvas'); dc.width = video.clientWidth; dc.height = video.clientHeight;
        window.addEventListener('resize', () => { gc.width = video.clientWidth; gc.height = video.clientHeight; dc.width = video.clientWidth; dc.height = video.clientHeight; });
    } catch (e) { showAIBubble('Camera access denied. Please allow camera.'); speak('Camera access denied.', true); }

    // Buttons
    document.getElementById('capture-btn')?.addEventListener('click', () => captureAndDescribe());
    document.getElementById('currency-btn')?.addEventListener('click', () => detectCurrency());
    document.getElementById('sos-btn')?.addEventListener('click', () => triggerSOS());
    document.getElementById('mic-indicator')?.addEventListener('click', () => { if (recognitionActive) stopRecognition(); else startRecognition(); });

    // Text input for motor-impaired users
    const textSend = document.getElementById('sathi-text-send');
    const textField = document.getElementById('sathi-text-field');
    if (textSend && textField) {
        const sendText = () => {
            const q = textField.value.trim();
            if (!q) return;
            textField.value = '';
            captureAndDescribe(q);
        };
        textSend.addEventListener('click', sendText);
        textField.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });
    }

    // Tilt detection
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(s => { if (s === 'granted') window.addEventListener('deviceorientation', handleTilt); }).catch(() => { });
    } else { window.addEventListener('deviceorientation', handleTilt); }

    // ===== MOTOR IMPAIRMENT — KEYBOARD SHORTCUTS =====
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') { e.preventDefault(); captureAndDescribe(); }
        if (e.code === 'Enter') { e.preventDefault(); triggerSOS(); }
        if (e.code === 'Escape') window.speechSynthesis.cancel();
    });

    // ===== MOTOR IMPAIRMENT — LONG-PRESS TO DESCRIBE =====
    let pressTimer = null;
    document.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => {
            captureAndDescribe();
            if (navigator.vibrate) navigator.vibrate(100);
        }, 800);
    }, { passive: true });
    document.addEventListener('touchend', () => { clearTimeout(pressTimer); }, { passive: true });

    // ===== DOUBLE-TAP = IMMEDIATE SAFETY SCAN (blind-first gesture) =====
    let lastTapTime = 0;
    document.addEventListener('touchend', (e) => {
        if (e.target.closest('.bottom-nav, .sos-btn, .capture-btn, .cr-btn, .nav-item, button, a, input')) return;
        const now = Date.now();
        if (now - lastTapTime < 350) {
            // Double-tap detected!
            lastTapTime = 0;
            if (navigator.vibrate) navigator.vibrate(50); // tactile confirmation
            speak('Scanning for safety.', true);
            captureAndDescribe('URGENT SAFETY SCAN: Look very carefully at everything in front of this blind person. Is there a wall, stairs, curb, drop-off, obstacle, vehicle, or any danger? Describe exactly what they need to know to walk safely. If clear, say so.');
        } else {
            lastTapTime = now;
        }
    }, { passive: true });

    // ===== MOTOR IMPAIRMENT — TRIPLE-TAP = SOS =====
    let tapCount = 0, tapTimer = null;
    document.addEventListener('touchend', (e) => {
        // Don't trigger on nav/button taps
        if (e.target.closest('.bottom-nav, .sos-btn, .capture-btn, .cr-btn, .nav-item, button, a')) return;
        tapCount++;
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => { tapCount = 0; }, 500);
        if (tapCount >= 3) {
            tapCount = 0;
            triggerSOS();
        }
    }, { passive: true });

    // ===== OFFLINE BADGE =====
    const offlineBadge = document.getElementById('offline-badge');
    if (!navigator.onLine && offlineBadge) offlineBadge.style.display = 'block';
    window.addEventListener('offline', () => {
        if (offlineBadge) offlineBadge.style.display = 'block';
    });
    window.addEventListener('online', () => {
        if (offlineBadge) offlineBadge.style.display = 'none';
    });

    // Start — BLIND-FIRST: immediate orientation, then proactive monitoring
    if (!recognition) setupRecognition();
    speak('SATHI is ready. Checking your surroundings now.', true);
    setTimeout(() => {
        if (!recognitionActive) startRecognition();
        // FIRST SCAN: Full safety orientation for blind user
        captureAndDescribe('FIRST ORIENTATION: This person just opened the app and cannot see. Describe their immediate environment: What is directly ahead? Any obstacles, walls, stairs, or dangers? What kind of space is this (room, corridor, outdoors)? Give them confidence about their surroundings.');
        lastDescribeTime = Date.now();
        startCocoDetection();
        initMotionDescribe();
        keepScreenOn();
        initDeviceMonitors();
        initCareReminders();
        initGeofenceMonitor();
        startLightLevelMonitor();
        startSafetyHeartbeat(); // periodic "all clear" for blind users
        // Offline check on startup
        if (!navigator.onLine) {
            speak('You are offline. Camera detection still works. AI description and SOS need internet.', true);
            showAIBubble('📵 Offline — Camera works, AI needs internet');
        }
        const s = document.getElementById('hud-status');
        if (s) s.textContent = 'AI Active — Watching for You';
    }, 3000);
};

// ===== SAFETY HEARTBEAT (Blind users need to know app is alive) =====
let safetyHeartbeatTimer = null;
let lastSafetyAnnounce = 0;
let lastProactiveScan = 0;

const startSafetyHeartbeat = () => {
    // Every 30s: if no obstacle warning was spoken recently, give subtle "still watching" feedback
    safetyHeartbeatTimer = setInterval(() => {
        if (appState !== 'camera') return;
        const now = Date.now();
        const timeSinceLastWarn = now - Math.max(lastObstacleWarn, lastCollisionWarn);
        const timeSinceLastDescribe = now - lastDescribeTime;

        // If 30s of silence (no warnings, no descriptions), give reassurance
        if (timeSinceLastWarn > 30000 && timeSinceLastDescribe > 30000 && now - lastSafetyAnnounce > 30000) {
            lastSafetyAnnounce = now;
            // Subtle vibration pulse = "I'm still here, watching"
            if (navigator.vibrate) navigator.vibrate([30, 100, 30]);
            // Every 3rd heartbeat, actually speak "path clear"
            if (Math.random() < 0.33) {
                speak('Path clear.', false);
            }
        }

        // PROACTIVE SAFETY SCAN: Every 45s during walking, ask LLM about walls/stairs
        // This catches things COCO-SSD cannot detect (walls, glass, stairs, curbs)
        if (now - lastProactiveScan > 45000 && now - lastDescribeTime > 20000 && !isDescribing) {
            lastProactiveScan = now;
            const video = document.getElementById('camera-feed');
            if (video && video.videoWidth) {
                // Use a lightweight safety-specific query
                captureAndDescribe('SAFETY ONLY: Is there a wall, dead-end, stairs, curb, or drop-off directly ahead? Answer in one sentence. If path is clear, say nothing.');
            }
        }
    }, 10000); // check every 10s
};

// ===== IMPROVED TILT DETECTION =====
let lastTiltWarnTime = 0;
const handleTilt = (e) => {
    if (e.beta === null) return;
    const now = Date.now();
    // Phone nearly flat (facing ceiling) — warn once per 15s
    if (e.beta < 20 && (now - lastTiltWarnTime > 15000)) {
        lastTiltWarnTime = now;
        speak('Please hold phone upright for better camera view.', false);
    }
};

// ===== COCO-SSD DETECTION LOOP (ENHANCED SAFETY) =====
let cocoRunning = false;
let previousObjSize = 0; // for rapid-approach detection
let lastCollisionWarn = 0; // urgent collision cooldown
let lastObstacleSpokenObj = ''; // avoid repeating same object
let consecutiveCloseFrames = 0; // track how long something stays close

// HIGH-DANGER objects that need extra warning
const DANGER_OBJECTS = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'train', 'dog', 'horse']);
const TRIP_HAZARDS = new Set(['chair', 'bench', 'suitcase', 'backpack', 'handbag', 'skateboard', 'sports ball', 'bottle']);

const startCocoDetection = async () => {
    try { await visionAI.detectObjects(document.getElementById('camera-feed')); } catch (e) { return; }
    cocoRunning = true;
    runCocoDetection();
};

const runCocoDetection = async () => {
    try {
        const video = document.getElementById('camera-feed');
        const canvas = document.getElementById('detect-canvas');
        if (!video || !canvas || !video.videoWidth) { if (cocoRunning) setTimeout(runCocoDetection, 300); return; }
        const predictions = await visionAI.detectObjects(video);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const scaleX = canvas.width / video.videoWidth;
        const scaleY = canvas.height / video.videoHeight;
        let maxRelativeHeight = 0;
        let closestObj = null;
        let objectsInPath = []; // track all objects in the walking path

        predictions.forEach(p => {
            const [x, y, w, h] = p.bbox;
            const sx = x * scaleX, sy = y * scaleY, sw = w * scaleX, sh = h * scaleY;
            if (!isInsideGuideZone([sx, sy, sw, sh], canvas.width, canvas.height)) return;

            const relativeHeight = h / video.videoHeight;
            const relativeWidth = w / video.videoWidth;
            const relativeArea = relativeHeight * relativeWidth; // larger area = closer
            
            if (relativeHeight > maxRelativeHeight) {
                maxRelativeHeight = relativeHeight;
                closestObj = p;
            }

            // Track all objects in walking path for multi-object awareness
            const centerX = x + (w / 2);
            let labelDirection = "ahead";
            if (centerX < video.videoWidth * 0.3) labelDirection = "left";
            else if (centerX > video.videoWidth * 0.7) labelDirection = "right";
            else labelDirection = "ahead"; // center zone = directly in path
            
            objectsInPath.push({ class: p.class, direction: labelDirection, relativeHeight, relativeArea, centerX });

            // Color coding — more granular
            let color = '#00ff00'; // GREEN (far)
            if (relativeHeight > 0.7) color = '#ff0000'; // BRIGHT RED (collision imminent)
            else if (relativeHeight > 0.5) color = '#ff3344'; // RED (very close)
            else if (relativeHeight >= 0.3) color = '#ffcc00'; // YELLOW (nearby)
            else if (relativeHeight >= 0.15) color = '#66ff66'; // LIGHT GREEN (approaching)

            ctx.strokeStyle = color; ctx.lineWidth = relativeHeight > 0.5 ? 4 : 2; 
            ctx.setLineDash(relativeHeight > 0.5 ? [] : [4, 4]); // solid line when close
            ctx.strokeRect(sx, sy, sw, sh);
            const label = `${p.class} ${labelDirection}`;
            ctx.font = `bold ${relativeHeight > 0.5 ? 16 : 12}px Inter`;
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = color; ctx.fillRect(sx, sy - (relativeHeight > 0.5 ? 24 : 20), tw + 8, relativeHeight > 0.5 ? 24 : 20);
            ctx.fillStyle = '#000'; ctx.fillText(label, sx + 4, sy - 6);
        });

        let fakeDist = Infinity;
        if (maxRelativeHeight > 0.0) {
            fakeDist = Math.max(0.2, 3.0 - (maxRelativeHeight * 3.5)); // more aggressive distance mapping
        }
        if (fakeDist < 3.0) ProximityBeep.update(fakeDist); else ProximityBeep.stop();

        // ===== RAPID APPROACH DETECTION =====
        // If object grew significantly between frames, user is walking toward it fast
        const sizeGrowth = maxRelativeHeight - previousObjSize;
        previousObjSize = maxRelativeHeight;

        const now = Date.now();

        // ===== COLLISION IMMINENT (>70% frame) — URGENT INTERRUPT =====
        if (maxRelativeHeight > 0.7 && closestObj) {
            consecutiveCloseFrames++;
            if (now - lastCollisionWarn > 2000) { // every 2s when in danger
                lastCollisionWarn = now;
                const obj = closestObj.class;
                const isDanger = DANGER_OBJECTS.has(obj);
                if (isDanger) {
                    speak(`STOP! ${obj} right in front of you!`, true);
                } else {
                    speak(`Stop! ${obj} directly ahead!`, true);
                }
                if (navigator.vibrate) navigator.vibrate([200, 50, 200, 50, 200, 50, 200]); // urgent pattern
                showAIBubble(`🛑 COLLISION WARNING: ${obj}`);
            }
        }
        // ===== VERY CLOSE (>50% frame) — strong warning every 3s =====
        else if (maxRelativeHeight > 0.5 && closestObj) {
            consecutiveCloseFrames++;
            if (now - lastObstacleWarn > 3000) {
                lastObstacleWarn = now;
                const obj = closestObj.class;
                const centerX = closestObj.bbox[0] + (closestObj.bbox[2] / 2);
                let direction = "directly ahead";
                if (centerX < video.videoWidth * 0.3) direction = "on your left";
                else if (centerX > video.videoWidth * 0.7) direction = "on your right";
                
                const isTrip = TRIP_HAZARDS.has(obj);
                if (isTrip) {
                    speak(`Careful! ${obj} ${direction}. Step around it.`, false);
                } else {
                    speak(`${obj} very close ${direction}.`, false);
                }
                if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
            }
        }
        // ===== NEARBY (>30% frame) — warn every 5s =====
        else if (maxRelativeHeight >= 0.3 && closestObj) {
            consecutiveCloseFrames = 0;
            if (now - lastObstacleWarn > 5000) {
                lastObstacleWarn = now;
                const obj = closestObj.class;
                const centerX = closestObj.bbox[0] + (closestObj.bbox[2] / 2);
                let direction = "ahead";
                if (centerX < video.videoWidth * 0.3) direction = "on your left";
                else if (centerX > video.videoWidth * 0.7) direction = "on your right";

                speak(`${obj} nearby ${direction}.`, false);
                if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
            }
        }
        // ===== APPROACHING (>15% frame) — gentle heads-up every 8s =====
        else if (maxRelativeHeight >= 0.15 && closestObj) {
            consecutiveCloseFrames = 0;
            if (now - lastObstacleWarn > 8000 && closestObj.class !== lastObstacleSpokenObj) {
                lastObstacleWarn = now;
                lastObstacleSpokenObj = closestObj.class;
                const obj = closestObj.class;
                const centerX = closestObj.bbox[0] + (closestObj.bbox[2] / 2);
                let direction = "ahead";
                if (centerX < video.videoWidth * 0.3) direction = "to your left";
                else if (centerX > video.videoWidth * 0.7) direction = "to your right";
                speak(`${obj} ${direction}.`, false); // non-interrupting
            }
        } else {
            consecutiveCloseFrames = 0;
            lastObstacleSpokenObj = '';
        }

        // ===== RAPID APPROACH WARNING — object growing fast =====
        if (sizeGrowth > 0.08 && maxRelativeHeight > 0.25 && closestObj) {
            if (now - lastCollisionWarn > 3000) {
                lastCollisionWarn = now;
                speak(`Slow down! ${closestObj.class} getting closer fast.`, true);
                if (navigator.vibrate) navigator.vibrate([150, 50, 150, 50, 150]);
            }
        }

        // ===== MULTIPLE OBJECTS BLOCKING PATH =====
        const aheadObjects = objectsInPath.filter(o => o.direction === 'ahead' && o.relativeHeight > 0.2);
        if (aheadObjects.length >= 2 && now - lastObstacleWarn > 6000) {
            lastObstacleWarn = now;
            const names = [...new Set(aheadObjects.map(o => o.class))].join(' and ');
            speak(`Multiple objects ahead: ${names}. Navigate carefully.`, false);
        }

        if (Math.random() < 0.1) checkLowLight(video);
    } catch (e) { }
    if (cocoRunning) setTimeout(runCocoDetection, 300); // ultra-fast detection loop for real-time tracking
};

// ===== GEOLOCATION =====
if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
        (pos) => { window.lastKnownLocation = { latitude: pos.coords.latitude.toString(), longitude: pos.coords.longitude.toString() }; },
        () => { }, { enableHighAccuracy: true }
    );
}

// ===== PROFILE HELPERS =====
const PROFILE_KEY = 'sathi_user_profile';
const loadProfile = () => { try { return JSON.parse(localStorage.getItem(PROFILE_KEY)); } catch { return null; } };
const saveProfile = (p) => { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); };

// Store guardian phone globally so SOS routing can use it
let guardianPhone = null;

// ============================================================
//  ONBOARDING FLOW  (5 steps, runs ONCE)
// ============================================================
const DISABILITY_OPTIONS = [
    { id: 'visual',  icon: '👁️', label: 'Visual Impairment' },
    { id: 'hearing', icon: '👂', label: 'Hearing Impairment' },
    { id: 'dyslexia', icon: '🧠', label: 'Dyslexia / Reading' },
    { id: 'motor',   icon: '🦽', label: 'Motor Impairment' },
    { id: 'elderly', icon: '👴', label: 'Elderly Care' },
    { id: 'other',   icon: '❓', label: 'Other' }
];

const LANGUAGES = [
    { code: 'en-US', label: 'English' },
    { code: 'hi-IN', label: 'हिन्दी' },
    { code: 'mr-IN', label: 'मराठी' },
    { code: 'ta-IN', label: 'தமிழ்' },
    { code: 'bn-IN', label: 'বাংলা' },
    { code: 'gu-IN', label: 'ગુજરાતી' },
    { code: 'ur-IN', label: 'اردو' }
];

const showOnboarding = () => {
    const savedRole = localStorage.getItem('sathi_role');
    const profile = { userType: savedRole === 'user' ? 'self' : (savedRole === 'guardian' ? 'guardian' : null), disabilities: [], guardian: { name: '', phone: '', homeTime: '' }, language: 'en-US' };
    let step = savedRole ? 1 : 0;

    // --- Build HTML ---
    app.innerHTML = `
    <div class="fixed inset-0 bg-background text-primary font-worksans flex flex-col z-[10000] overflow-hidden" id="onboarding">
        <!-- Step dots -->
        <div class="flex gap-3 justify-center pt-8 pb-3 shrink-0" id="step-dots">
            ${[0,1,2,3,4].map(i => `<div class="w-3 h-3 border-2 border-[#1A1A1A] transition-all ${i === step ? 'bg-primary' : (i < step ? 'bg-primary opacity-50' : 'bg-transparent')}" data-dot="${i}"></div>`).join('')}
        </div>
        <div class="flex-1 relative overflow-hidden" id="step-viewport">

            <!-- STEP 1: Who needs help? -->
            <div class="step-slide absolute inset-0 flex flex-col items-center p-6 overflow-y-auto transition-all duration-500 ease-in-out ${step === 0 ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0 pointer-events-none'}" data-step="0">
                <h2 class="text-3xl font-newsreader font-bold text-center mb-2">Who is Sathi for?</h2>
                <p class="text-lg opacity-70 text-center mb-8">Choose the option that fits best</p>
                <div class="grid grid-cols-2 gap-4 w-full max-w-[420px]">
                    <div class="ob-card group bg-surface border-2 border-[#1A1A1A] p-8 flex flex-col items-center gap-3 cursor-pointer transition-all hover:-translate-y-1 hover:shadow-brutal" data-type="self" id="card-self">
                        <span class="text-5xl group-hover:scale-110 transition-transform">👤</span>
                        <span class="text-lg font-bold text-center">For Me</span>
                        <span class="text-sm opacity-60 text-center">I have a disability</span>
                    </div>
                    <div class="ob-card group bg-surface border-2 border-[#1A1A1A] p-8 flex flex-col items-center gap-3 cursor-pointer transition-all hover:-translate-y-1 hover:shadow-brutal" data-type="guardian" id="card-guardian">
                        <span class="text-5xl group-hover:scale-110 transition-transform">👨‍👩‍👧</span>
                        <span class="text-lg font-bold text-center">For Someone</span>
                        <span class="text-sm opacity-60 text-center">I am a guardian</span>
                    </div>
                </div>
                <div class="mt-auto w-full max-w-[420px] pt-5">
                    <button class="w-full bg-primary text-surface font-bold py-4 border-2 border-[#1A1A1A] transition-all hover:-translate-y-1 hover:shadow-brutal disabled:opacity-50 disabled:pointer-events-none disabled:transform-none disabled:shadow-none" id="next-0" disabled>Next →</button>
                </div>
            </div>

            <!-- STEP 2: Disability multi-select -->
            <div class="step-slide absolute inset-0 flex flex-col items-center p-6 overflow-y-auto transition-all duration-500 ease-in-out ${step === 1 ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0 pointer-events-none'}" data-step="1">
                <h2 class="text-3xl font-newsreader font-bold text-center mb-2">Support Needs</h2>
                <p class="text-lg opacity-70 text-center mb-8">Select all that apply</p>
                <div class="grid grid-cols-2 gap-3 w-full max-w-[420px]" id="disability-grid">
                    ${DISABILITY_OPTIONS.map(d => `
                        <div class="ob-card group bg-surface border-2 border-[#1A1A1A] p-4 flex flex-col items-center gap-2 cursor-pointer transition-all hover:-translate-y-1 hover:shadow-brutal" data-dis="${d.id}">
                            <span class="text-3xl group-hover:scale-110 transition-transform">${d.icon}</span>
                            <span class="text-sm font-bold text-center">${d.label}</span>
                        </div>
                    `).join('')}
                </div>
                <div class="flex gap-3 mt-auto w-full max-w-[420px] pt-5">
                    <button class="flex-1 bg-background text-primary border-2 border-[#1A1A1A] font-bold py-4 transition-all hover:-translate-y-1 hover:shadow-brutal" id="back-1">← Back</button>
                    <button class="flex-1 bg-primary text-surface border-2 border-[#1A1A1A] font-bold py-4 transition-all hover:-translate-y-1 hover:shadow-brutal disabled:opacity-50 disabled:pointer-events-none disabled:transform-none disabled:shadow-none" id="next-1" disabled>Next →</button>
                </div>
            </div>

            <!-- STEP 3: Guardian setup -->
            <div class="step-slide absolute inset-0 flex flex-col items-center p-6 overflow-y-auto transition-all duration-500 ease-in-out translate-x-full opacity-0 pointer-events-none" data-step="2">
                <h2 class="text-3xl font-newsreader font-bold text-center mb-2">Emergency Contact</h2>
                <p class="text-lg opacity-70 text-center mb-8">Who should Sathi alert?</p>
                <div class="flex flex-col gap-5 w-full max-w-[420px]" id="guardian-form">
                    <div class="flex flex-col gap-1">
                        <label for="g-name" class="text-sm font-bold uppercase tracking-wider">Guardian Name</label>
                        <input id="g-name" type="text" placeholder="e.g. Mom, Arjun" autocomplete="name" class="bg-surface border-2 border-[#1A1A1A] p-4 text-lg outline-none focus:ring-2 focus:ring-primary focus:-translate-y-1 focus:shadow-brutal transition-all">
                        <span class="text-error text-sm min-h-[1.2em]" id="err-name"></span>
                    </div>
                    <div class="flex flex-col gap-1">
                        <label for="g-phone" class="text-sm font-bold uppercase tracking-wider">Guardian Phone (+91)</label>
                        <input id="g-phone" type="tel" placeholder="10 digit number" maxlength="10" inputmode="numeric" class="bg-surface border-2 border-[#1A1A1A] p-4 text-lg outline-none focus:ring-2 focus:ring-primary focus:-translate-y-1 focus:shadow-brutal transition-all">
                        <span class="text-error text-sm min-h-[1.2em]" id="err-phone"></span>
                    </div>

                </div>
                <div class="flex gap-3 mt-auto w-full max-w-[420px] pt-5">
                    <button class="flex-1 bg-background text-primary border-2 border-[#1A1A1A] font-bold py-4 transition-all hover:-translate-y-1 hover:shadow-brutal" id="back-2">← Back</button>
                    <button class="flex-1 bg-primary text-surface border-2 border-[#1A1A1A] font-bold py-4 transition-all hover:-translate-y-1 hover:shadow-brutal" id="next-2">Next →</button>
                </div>
            </div>

            <!-- STEP 4: Language -->
            <div class="step-slide absolute inset-0 flex flex-col items-center p-6 overflow-y-auto transition-all duration-500 ease-in-out translate-x-full opacity-0 pointer-events-none" data-step="3">
                <h2 class="text-3xl font-newsreader font-bold text-center mb-2">Language</h2>
                <p class="text-lg opacity-70 text-center mb-8">Sathi will speak in your preferred language</p>
                <div class="grid grid-cols-2 gap-3 w-full max-w-[420px]" id="lang-grid">
                    ${LANGUAGES.map(l => `
                        <button class="ob-lang-btn bg-surface text-[#1A1A1A] border-2 border-[#1A1A1A] py-4 font-bold text-lg transition-all hover:-translate-y-1 hover:shadow-brutal ${l.code === 'en-US' ? 'ring-2 ring-primary -translate-y-1 shadow-brutal' : ''}" data-lang="${l.code}">${l.label}</button>
                    `).join('')}
                </div>
                <div class="flex gap-3 mt-auto w-full max-w-[420px] pt-5">
                    <button class="flex-1 bg-background text-primary border-2 border-[#1A1A1A] font-bold py-4 transition-all hover:-translate-y-1 hover:shadow-brutal" id="back-3">← Back</button>
                    <button class="flex-1 bg-primary text-surface border-2 border-[#1A1A1A] font-bold py-4 transition-all hover:-translate-y-1 hover:shadow-brutal" id="next-3">Continue →</button>
                </div>
            </div>

            <!-- STEP 5: Ready -->
            <div class="step-slide absolute inset-0 flex flex-col items-center p-6 overflow-y-auto transition-all duration-500 ease-in-out translate-x-full opacity-0 pointer-events-none" data-step="4">
                <div class="flex flex-col items-center justify-center flex-1 text-center gap-6">
                    <div class="w-24 h-24 bg-safe border-4 border-[#1A1A1A] animate-pulse flex items-center justify-center">
                        <span class="material-symbols-outlined text-[#1A1A1A] text-5xl">check</span>
                    </div>
                    <h2 class="text-4xl font-newsreader font-bold">Sathi is ready.</h2>
                    <p class="text-xl opacity-70" id="ready-sub"></p>
                </div>
            </div>

        </div>
    </div>`;

    // --- Helpers ---
    const dots = Array.from(document.querySelectorAll('#step-dots div'));
    const slides = Array.from(document.querySelectorAll('.step-slide'));

    const goToStep = (target) => {
        const prev = step;
        step = target;
        onboardingStep = target; // Sync global state for voice routing
        slides.forEach((s, i) => {
            s.className = 'step-slide absolute inset-0 flex flex-col items-center p-6 overflow-y-auto transition-all duration-500 ease-in-out';
            if (i === step)       s.classList.add('translate-x-0', 'opacity-100');
            else if (i < step)    s.classList.add('-translate-x-full', 'opacity-0', 'pointer-events-none');
            else                  s.classList.add('translate-x-full', 'opacity-0', 'pointer-events-none');
        });
        dots.forEach((d, i) => {
            d.className = 'w-3 h-3 border-2 border-[#1A1A1A] transition-all';
            if (i === step)       d.classList.add('bg-primary');
            else if (i < step)    d.classList.add('bg-primary', 'opacity-50');
            else                  d.classList.add('bg-transparent');
        });

        // Voice Prompts for Onboarding
        if (step === 0) {
            speak('Who is Sathi for? Please say "For Me" or "For Someone".', true);
        } else if (step === 1) {
            speak('What are your support needs? Say Visual, Hearing, Dyslexia, Motor, or Elderly. Then say Next.', true);
        } else if (step === 2) {
            speak('Please enter emergency contact details. You can say "Name is [Your Name]" or "Number is [Your 10 digit number]".', true);
        } else if (step === 3) {
            speak('Choose your language. Say English, Hindi, Marathi, Tamil, Bengali, Gujarati, or Urdu.', true);
        }
    };

    // Initial Voice Prompt
    setTimeout(() => {
        if (step === 0) {
            speak('Who is Sathi for? Please say "For Me" or "For Someone".', true);
        } else if (step === 1) {
            speak('What are your support needs? Say Visual, Hearing, Dyslexia, Motor, or Elderly. Then say Next.', true);
        }
    }, 500);

    // --- STEP 1 logic ---
    const next0 = document.getElementById('next-0');
    document.querySelectorAll('[data-type]').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('[data-type]').forEach(c => c.classList.remove('ring-2', 'ring-primary', '-translate-y-1', 'shadow-brutal'));
            card.classList.add('ring-2', 'ring-primary', '-translate-y-1', 'shadow-brutal');
            profile.userType = card.dataset.type;
            next0.disabled = false;
        });
    });
    next0.addEventListener('click', () => goToStep(1));

    // --- STEP 2 logic ---
    const next1 = document.getElementById('next-1');
    document.querySelectorAll('[data-dis]').forEach(card => {
        card.addEventListener('click', () => {
            card.classList.toggle('ring-2');
            card.classList.toggle('ring-primary');
            card.classList.toggle('-translate-y-1');
            card.classList.toggle('shadow-brutal');
            profile.disabilities = Array.from(document.querySelectorAll('[data-dis].ring-primary')).map(c => c.dataset.dis);
            next1.disabled = profile.disabilities.length === 0;
        });
    });
    document.getElementById('back-1').addEventListener('click', () => goToStep(0));
    next1.addEventListener('click', () => goToStep(2));

    // --- STEP 3 logic ---
    const validateStep3 = () => {
        const nameEl = document.getElementById('g-name');
        const phoneEl = document.getElementById('g-phone');
        const errName = document.getElementById('err-name');
        const errPhone = document.getElementById('err-phone');
        let valid = true;

        const name = nameEl.value.trim();
        const phone = phoneEl.value.trim();

        if (!name) { errName.textContent = 'Name is required'; nameEl.classList.add('invalid'); valid = false; }
        else { errName.textContent = ''; nameEl.classList.remove('invalid'); }

        if (!/^\d{10}$/.test(phone)) { errPhone.textContent = 'Enter a valid 10-digit phone number'; phoneEl.classList.add('invalid'); valid = false; }
        else { errPhone.textContent = ''; phoneEl.classList.remove('invalid'); }

        if (valid) {
            profile.guardian.name = name;
            profile.guardian.phone = phone;
        }
        return valid;
    };

    // Clear errors on input
    document.getElementById('g-name').addEventListener('input', () => { document.getElementById('err-name').textContent = ''; document.getElementById('g-name').classList.remove('invalid'); });
    document.getElementById('g-phone').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); document.getElementById('err-phone').textContent = ''; e.target.classList.remove('invalid'); });

    document.getElementById('back-2').addEventListener('click', () => goToStep(1));
    document.getElementById('next-2').addEventListener('click', () => { if (validateStep3()) goToStep(3); });

    // --- STEP 4 logic ---
    // Default to English
    profile.language = 'en-US';
    document.querySelectorAll('[data-lang]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-lang]').forEach(b => b.classList.remove('ring-2', 'ring-primary', '-translate-y-1', 'shadow-brutal'));
            btn.classList.add('ring-2', 'ring-primary', '-translate-y-1', 'shadow-brutal');
            profile.language = btn.dataset.lang;
        });
    });
    document.getElementById('back-3').addEventListener('click', () => goToStep(2));
    document.getElementById('next-3').addEventListener('click', () => {
        // Save profile, show ready screen
        saveProfile(profile);
        lang = profile.language;
        guardianPhone = profile.guardian.phone;

        // Set ready subtext
        const sub = document.getElementById('ready-sub');
        sub.textContent = profile.userType === 'self' ? "You're never alone." : 'Your loved one is protected.';

        goToStep(4);
        speak('Sathi is ready. You are never alone.', true);

        // Auto-proceed after 2 seconds
        setTimeout(() => {
            const ob = document.getElementById('onboarding');
            if (ob) ob.remove();
            launchCameraWithProfile(profile);
        }, 2500);
    });
};

// ===== LAUNCH CAMERA (profile-aware) =====
const launchCameraWithProfile = (profile) => {
    lang = profile.language || 'en-US';
    guardianPhone = profile.guardian?.phone || null;

    goToCameraHUD().then(() => {
        if (profile.disabilities.includes('hearing')) {
            isCaptionMode = true;
            transcriptBuffer = '';
        }
        if (profile.disabilities.includes('dyslexia')) {
            setTimeout(() => activateDyslexiaMode(), 1000);
        }
    });
};

// ===== CONVERSATION FEED UI =====
const updateConvFeed = () => {
    const container = document.getElementById('conv-feed');
    if (!container) return;
    const recent = conversationHistory.slice(-6);
    container.innerHTML = recent.map(m => {
        const cls = m.role === 'user' ? 'user' : 'assistant';
        const text = typeof m.content === 'string' ? m.content : (m.content || '');
        return `<div class="conv-msg ${cls}">${text.length > 80 ? text.slice(0, 80) + '…' : text}</div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
};

const showQuickChips = () => {
    const existing = document.getElementById('quick-chips');
    if (existing) existing.remove();
    const container = document.getElementById('hud-bottom-area');
    if (!container) return;
    const chips = CHIP_SETS[chipSetIndex % CHIP_SETS.length];
    chipSetIndex++;
    const div = document.createElement('div');
    div.className = 'quick-chips';
    div.id = 'quick-chips';
    div.setAttribute('role', 'group');
    div.setAttribute('aria-label', 'Quick reply options');
    chips.forEach(text => {
        const btn = document.createElement('button');
        btn.className = 'quick-chip';
        btn.textContent = text;
        btn.setAttribute('aria-label', text);
        btn.addEventListener('click', () => {
            div.remove();
            captureAndDescribe(text);
        });
        div.appendChild(btn);
    });
    const aiB = document.getElementById('ai-bubble');
    if (aiB) aiB.after(div);
    else container.prepend(div);
};

// ===== ACCESSIBILITY TOOLBAR =====
const injectA11yToolbar = () => {
    const saved = localStorage.getItem('sathi_font_scale');
    if (saved) document.documentElement.style.setProperty('--font-scale', saved);
    const hc = localStorage.getItem('sathi_high_contrast');
    if (hc === 'true') document.body.classList.add('high-contrast');

    const bar = document.createElement('div');
    bar.className = 'a11y-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Accessibility controls');
    bar.innerHTML = `
        <button class="a11y-btn" id="a11y-up" aria-label="Increase font size" title="Increase font size">A+</button>
        <button class="a11y-btn" id="a11y-down" aria-label="Decrease font size" title="Decrease font size">A-</button>
        <button class="a11y-btn ${hc === 'true' ? 'active' : ''}" id="a11y-hc" aria-label="Toggle high contrast" title="High contrast">HC</button>
    `;
    document.body.appendChild(bar);

    document.getElementById('a11y-up').addEventListener('click', () => {
        let s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale')) || 1;
        s = Math.min(s + 0.15, 2);
        document.documentElement.style.setProperty('--font-scale', s);
        localStorage.setItem('sathi_font_scale', s);
        speak('Font size increased', false);
    });
    document.getElementById('a11y-down').addEventListener('click', () => {
        let s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale')) || 1;
        s = Math.max(s - 0.15, 0.7);
        document.documentElement.style.setProperty('--font-scale', s);
        localStorage.setItem('sathi_font_scale', s);
        speak('Font size decreased', false);
    });
    document.getElementById('a11y-hc').addEventListener('click', () => {
        document.body.classList.toggle('high-contrast');
        const on = document.body.classList.contains('high-contrast');
        localStorage.setItem('sathi_high_contrast', on);
        document.getElementById('a11y-hc').classList.toggle('active', on);
        speak(on ? 'High contrast on' : 'High contrast off', false);
    });
};

// ===== LOGIN SCREEN =====
const showLoginScreen = () => {
    let selectedRole = null;
    app.innerHTML = `
    <div class="login-screen" id="login-screen" role="dialog" aria-label="SATHI Login">
        <div class="login-brand">
            <div class="login-title">SATHI</div>
            <div class="login-tagline">साथी — Your Accessibility Companion</div>
        </div>
        <div class="login-cards" role="group" aria-label="Select your role">
            <div class="login-card" id="lc-user" tabindex="0" role="button" aria-label="I am the User, person with disability">
                <span class="lc-icon">👤</span>
                <span class="lc-title">I am the User</span>
                <span class="lc-desc">Person with disability</span>
            </div>
            <div class="login-card" id="lc-guardian" tabindex="0" role="button" aria-label="I am a Guardian, family member or caregiver">
                <span class="lc-icon">🛡️</span>
                <span class="lc-title">I am a Guardian</span>
                <span class="lc-desc">Family member or caregiver</span>
            </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:12px;width:100%;max-width:400px;">
            <input type="text" class="login-pin-input" id="login-pin" placeholder="Enter PIN (optional)" aria-label="Enter PIN" style="width:100%;border:2px solid #1A1A1A;background:#FFFFFF;padding:16px;font-size:0.9rem;font-family:'Work Sans',sans-serif;letter-spacing:2px;text-align:center;outline:none;">
            <button class="login-continue-btn" id="login-continue" disabled aria-label="Continue">Continue →</button>
            <span style="font-size:0.7rem;opacity:0.4;letter-spacing:1px;text-transform:uppercase;font-family:'Work Sans',sans-serif;color:#1A1A1A;">🔒 Your data stays on this device only</span>
        </div>
    </div>`;

    // Voice announce
    setTimeout(() => {
        speak('Welcome to Sathi. Tap I am the User or I am a Guardian, then tap continue.', true);
    }, 500);

    const userCard = document.getElementById('lc-user');
    const guardianCard = document.getElementById('lc-guardian');
    const continueBtn = document.getElementById('login-continue');

    const selectCard = (role) => {
        selectedRole = role;
        userCard.classList.toggle('selected', role === 'user');
        guardianCard.classList.toggle('selected', role === 'guardian');
        continueBtn.disabled = false;
        continueBtn.textContent = role === 'guardian' ? 'Continue to Dashboard →' : 'Continue →';
        speak(role === 'user' ? 'User selected' : 'Guardian selected', false);
    };

    userCard.addEventListener('click', () => selectCard('user'));
    guardianCard.addEventListener('click', () => selectCard('guardian'));
    userCard.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectCard('user'); });
    guardianCard.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectCard('guardian'); });

    continueBtn.addEventListener('click', () => {
        if (!selectedRole) return;
        localStorage.setItem('sathi_logged_in', 'true');
        localStorage.setItem('sathi_role', selectedRole);
        if (selectedRole === 'guardian') {
            window.location.href = '/dashboard';
        } else {
            const ls = document.getElementById('login-screen');
            if (ls) ls.remove();
            const existing = loadProfile();
            if (existing && existing.userType) {
                launchCameraWithProfile(existing);
            } else {
                showOnboarding();
            }
        }
    });
};

// ===== UPDATED goToCameraHUD — add LIVE indicator, conv feed, text input =====
const _origGoToCameraHUD = goToCameraHUD;
window.goToCameraHUD = () => {
    appState = 'camera';
    _origGoToCameraHUD();
};

// ===== INIT =====
const initApp = () => {
    injectA11yToolbar();
    setupRecognition();
    startRecognition();
    
    const loggedIn = localStorage.getItem('sathi_logged_in');
    if (loggedIn) {
        const role = localStorage.getItem('sathi_role');
        if (role === 'guardian') {
            window.location.href = '/dashboard';
            return;
        }
        const existing = loadProfile();
        if (existing && existing.userType) {
            launchCameraWithProfile(existing);
        } else {
            showOnboarding();
        }
    } else {
        showLoginScreen();
    }
};

initApp();

