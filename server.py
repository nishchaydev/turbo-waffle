from dotenv import load_dotenv
load_dotenv()

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from coordinator_agent import CoordinatorAgent
from vision_agent import VisionAgent
from voice_agent import VoiceAgent
from subtitle_agent import SubtitleAgent
from sos_agent import SOSAgent
from reminder_agent import ReminderAgent
from sound_agent import SoundDetectionAgent
import os
import json
import tempfile
import traceback
import httpx
from datetime import datetime, timezone, timedelta

app = Flask(__name__, static_folder='frontend')
CORS(app)

# Initialize Agents
coordinator = CoordinatorAgent()
vision = VisionAgent()
voice = VoiceAgent()
subtitle = SubtitleAgent()
sos = SOSAgent()
reminder = ReminderAgent()
sound = SoundDetectionAgent()

# ===== Persistent event log (file-backed) =====
EVENT_LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'event_log.json')
CARE_PROFILE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'care_profile.json')

def _load_event_log():
    """Load event log from disk. Returns list."""
    try:
        if os.path.exists(EVENT_LOG_FILE):
            with open(EVENT_LOG_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
    except (json.JSONDecodeError, IOError):
        pass
    return []

def _save_event_log():
    """Persist event log to disk (keeps last 100 events)."""
    try:
        trimmed = event_log[-100:]  # prevent unbounded growth
        with open(EVENT_LOG_FILE, 'w', encoding='utf-8') as f:
            json.dump(trimmed, f, ensure_ascii=False)
    except IOError:
        pass

def _load_care_profile():
    """Load care profile from disk."""
    try:
        if os.path.exists(CARE_PROFILE_FILE):
            with open(CARE_PROFILE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except (json.JSONDecodeError, IOError):
        pass
    return {"medicines": [], "reminders": [], "medical_info": {"allergies": "", "blood_type": "", "conditions": "", "emergency_notes": ""}}

def _save_care_profile(profile):
    """Persist care profile to disk."""
    try:
        with open(CARE_PROFILE_FILE, 'w', encoding='utf-8') as f:
            json.dump(profile, f, ensure_ascii=False, indent=2)
    except IOError:
        pass

# Load persisted data on startup
event_log = _load_event_log()
care_profile = _load_care_profile()

# Register Agents
coordinator.register_agent("vision", vision)
coordinator.register_agent("voice", voice)
coordinator.register_agent("subtitle", subtitle)
coordinator.register_agent("sos", sos)
coordinator.register_agent("reminder", reminder)
coordinator.register_agent("sound", sound)

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/dashboard')
def dashboard():
    return send_from_directory(app.static_folder, 'dashboard.html')

@app.route('/classroom')
def classroom():
    return send_from_directory(app.static_folder, 'classroom.html')

@app.route('/api/dashboard-feed')
def dashboard_feed():
    return jsonify({"events": event_log[-20:]})

# --- CLASSROOM: Groq Whisper transcription + LLM classification ---
@app.route('/api/classroom', methods=['POST'])
def classroom_analyze():
    groq_key = os.environ.get('GROQ_API_KEY')
    if not groq_key:
        return jsonify({"error": "GROQ_API_KEY not set"}), 500

    audio_file = request.files.get('audio')
    if not audio_file:
        return jsonify({"error": "No audio file provided"}), 400

    tmp_path = None
    try:
        # Save uploaded audio to a temp file
        with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as tmp:
            audio_file.save(tmp)
            tmp_path = tmp.name

        # Step 1: Transcribe with Groq Whisper
        with open(tmp_path, 'rb') as f:
            whisper_resp = httpx.post(
                'https://api.groq.com/openai/v1/audio/transcriptions',
                headers={'Authorization': f'Bearer {groq_key}'},
                files={'file': ('classroom.webm', f, 'audio/webm')},
                data={'model': 'whisper-large-v3', 'language': 'en'},
                timeout=30
            )

        if whisper_resp.status_code != 200:
            app.logger.error(f"Whisper error {whisper_resp.status_code}: {whisper_resp.text}")
            return jsonify({"error": "Transcription failed", "detail": whisper_resp.text}), 502

        transcript = whisper_resp.json().get('text', '').strip()

        if not transcript or len(transcript) < 5:
            return jsonify({"priority": "SKIP", "summary": "Silence or noise", "transcript": transcript})

        # Step 2: Classify with Groq LLM
        classify_prompt = f"""You are a classroom audio classifier for an accessibility companion app.

Transcript:
\"\"\"
{transcript}
\"\"\"

Classify this transcript into EXACTLY ONE of these priorities:
- URGENT: emergency, danger, fire, medical, someone hurt, evacuation
- IMPORTANT: teacher instructions, homework, exam dates, schedule changes
- NOTES: regular lecture content, explanations, definitions
- ANNOUNCE: general announcements, events, non-academic
- SKIP: noise, chatter, silence, irrelevant

Respond in EXACTLY this JSON format and nothing else:
{{"priority": "NOTES", "summary": "max 8 word summary here"}}"""

        llm_resp = httpx.post(
            'https://api.groq.com/openai/v1/chat/completions',
            headers={
                'Authorization': f'Bearer {groq_key}',
                'Content-Type': 'application/json'
            },
            json={
                'model': 'llama-3.3-70b-versatile',
                'messages': [{'role': 'user', 'content': classify_prompt}],
                'temperature': 0.1,
                'max_tokens': 100
            },
            timeout=20
        )

        if llm_resp.status_code != 200:
            app.logger.error(f"LLM error {llm_resp.status_code}: {llm_resp.text}")
            return jsonify({"error": "Classification failed"}), 502

        llm_text = llm_resp.json()['choices'][0]['message']['content'].strip()

        # Parse JSON from LLM response
        try:
            # Handle possible markdown wrapping
            if '```' in llm_text:
                llm_text = llm_text.split('```')[1]
                if llm_text.startswith('json'):
                    llm_text = llm_text[4:]
            result = json.loads(llm_text.strip())
        except json.JSONDecodeError:
            result = {"priority": "NOTES", "summary": transcript[:50]}

        priority = result.get('priority', 'NOTES').upper()
        summary = result.get('summary', transcript[:50])

        # Validate priority
        if priority not in ('URGENT', 'IMPORTANT', 'NOTES', 'ANNOUNCE', 'SKIP'):
            priority = 'NOTES'

        now_iso = datetime.now(timezone.utc).isoformat()

        # Log to event feed
        event_log.append({
            "type": "classroom",
            "priority": priority,
            "summary": summary,
            "description": f"[{priority}] {summary}",
            "transcript": transcript,
            "time": now_iso
        })
        _save_event_log()

        # If URGENT, also create an SOS-style event
        if priority == 'URGENT':
            event_log.append({
                "type": "sos",
                "description": f"CLASSROOM URGENT: {summary}",
                "time": now_iso
            })
            _save_event_log()

        return jsonify({
            "priority": priority,
            "summary": summary,
            "transcript": transcript
        })

    except Exception as e:
        app.logger.error(f"Classroom error: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

@app.route('/api/start-mode', methods=['POST'])
def start_mode():
    data = request.json
    mode = data.get('mode')
    response = coordinator.route(f"start {mode}")
    return jsonify({"status": "success", "message": response})

# --- VISION: accepts base64 image for Groq Vision analysis ---
@app.route('/api/vision', methods=['GET', 'POST'])
def get_vision():
    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        image_b64 = data.get('image')
        language = data.get('language', 'en-US')
        query = data.get('query') # Extract user question
        memory = data.get('memory', '') # Scene memory context
        result = vision.run({"image": image_b64, "language": language, "query": query, "memory": memory})
        # Log to event feed for Guardian Dashboard
        event_log.append({
            "type": "vision",
            "description": result if isinstance(result, str) else str(result),
            "time": datetime.now(timezone.utc).isoformat()
        })
        _save_event_log()
        return jsonify({"description": result})
    else:
        # Legacy GET — no image, just runs stub
        result = vision.run({"mode": "single"})
        return jsonify({"detected_object": result})

# --- SUBTITLES: accepts transcript for AI processing ---
@app.route('/api/subtitles', methods=['GET'])
def get_subtitles():
    result = subtitle.run({"action": "transcribe"})
    return jsonify({"text": result})

@app.route('/api/subtitle', methods=['POST'])
def process_subtitle():
    data = request.get_json(silent=True) or {}
    transcript = data.get('transcript', '')
    language = data.get('language', 'en')
    result = subtitle.process_transcript(transcript, language)
    return jsonify(result)

@app.route('/api/reminder', methods=['POST'])
def set_reminder():
    data = request.json
    result = reminder.run({"input": f"set reminder {data.get('medicine')}"})
    return jsonify({"message": result})

@app.route('/api/sos', methods=['GET', 'POST'])
def trigger_sos():
    data = request.get_json(silent=True) if request.method == 'POST' else {}
    if not data: data = {}
    lat = data.get('latitude', '28.6139')
    lon = data.get('longitude', '77.2090')
    photo = data.get('photo', None)
    medical = data.get('medical_info', care_profile.get('medical_info', {}))
    event_log.append({
        "type": "sos",
        "lat": lat,
        "lon": lon,
        "photo": photo,
        "medical_info": medical,
        "description": f"SOS at ({lat},{lon})",
        "time": datetime.now(timezone.utc).isoformat()
    })
    _save_event_log()
    
    # Bypass coordinator to pass full kwargs including photo
    params = {"trigger": "manual", "latitude": lat, "longitude": lon}
    if photo:
        params["photo"] = photo
    result = sos.run(params)
    
    if isinstance(result, dict):
        return jsonify(result)
    return jsonify({"status": "success", "message": result})

@app.route('/api/voice-command')
def get_voice_command():
    # Simulated voice command for browser demo
    result = voice.run({"text": "start assistance"})
    return jsonify({"command": result['command'], "intent": result['intent']})

# ===== CARE PROFILE API (Guardian Personalization) =====
@app.route('/api/care-profile', methods=['GET', 'POST'])
def care_profile_api():
    global care_profile
    if request.method == 'GET':
        return jsonify(care_profile)
    else:
        data = request.get_json(silent=True) or {}
        # Merge incoming data into care profile
        if 'medicines' in data:
            care_profile['medicines'] = data['medicines']
        if 'reminders' in data:
            care_profile['reminders'] = data['reminders']
        if 'medical_info' in data:
            care_profile['medical_info'] = data['medical_info']
        _save_care_profile(care_profile)
        # Log the update to event feed
        event_log.append({
            "type": "care_update",
            "description": "Guardian updated care profile",
            "time": datetime.now(timezone.utc).isoformat()
        })
        _save_event_log()
        return jsonify({"status": "success", "message": "Care profile saved."})

@app.route('/api/care-reminders')
def care_reminders_due():
    """Returns medicines & reminders due within the next 5 minutes."""
    now = datetime.now()
    current_time = now.strftime('%H:%M')
    current_minutes = now.hour * 60 + now.minute

    due_items = []

    # Check medicines
    for med in care_profile.get('medicines', []):
        for t in med.get('times', []):
            try:
                parts = t.split(':')
                med_minutes = int(parts[0]) * 60 + int(parts[1])
                diff = med_minutes - current_minutes
                if 0 <= diff <= 5:
                    due_items.append({
                        "type": "medicine",
                        "name": med.get('name', 'Medicine'),
                        "dosage": med.get('dosage', ''),
                        "time": t,
                        "instructions": med.get('instructions', '')
                    })
            except (ValueError, IndexError):
                pass

    # Check custom reminders
    for rem in care_profile.get('reminders', []):
        try:
            t = rem.get('time', '')
            parts = t.split(':')
            rem_minutes = int(parts[0]) * 60 + int(parts[1])
            diff = rem_minutes - current_minutes
            if 0 <= diff <= 5:
                due_items.append({
                    "type": "reminder",
                    "text": rem.get('text', 'Reminder'),
                    "time": t
                })
        except (ValueError, IndexError):
            pass

    return jsonify({"due": due_items, "medical_info": care_profile.get('medical_info', {})})

# ===== GEOFENCE SAFE ZONE API =====
@app.route('/api/geofence', methods=['GET', 'POST'])
def geofence_api():
    global care_profile
    if request.method == 'GET':
        return jsonify(care_profile.get('geofence', {"lat": None, "lon": None, "radius": 500, "enabled": False}))
    else:
        data = request.get_json(silent=True) or {}
        care_profile['geofence'] = {
            "lat": data.get('lat'),
            "lon": data.get('lon'),
            "radius": data.get('radius', 500),
            "label": data.get('label', 'Safe Zone'),
            "enabled": data.get('enabled', True)
        }
        _save_care_profile(care_profile)
        return jsonify({"status": "success", "message": "Geofence saved."})

@app.route('/api/geofence-alert', methods=['POST'])
def geofence_alert():
    data = request.get_json(silent=True) or {}
    event_log.append({
        "type": "geofence",
        "description": f"⚠️ LEFT SAFE ZONE — {data.get('label', 'Safe Zone')} ({data.get('distance', '?')}m away)",
        "lat": data.get('lat'),
        "lon": data.get('lon'),
        "time": datetime.now(timezone.utc).isoformat()
    })
    _save_event_log()
    return jsonify({"status": "alert_logged"})

# ===== FALL DETECTION ALERT API =====
@app.route('/api/fall-alert', methods=['POST'])
def fall_alert():
    data = request.get_json(silent=True) or {}
    status = data.get('status', 'unknown')  # 'triggered' or 'cancelled'
    lat = data.get('lat')
    lon = data.get('lon')
    now_iso = datetime.now(timezone.utc).isoformat()

    if status == 'triggered':
        description = f"🚨 FALL DETECTED — Auto-SOS triggered at ({lat},{lon})"
        event_type = "fall_sos"
    else:
        description = f"⚠️ Fall detected — User responded OK"
        event_type = "fall_cancelled"

    event_log.append({
        "type": event_type,
        "description": description,
        "lat": lat,
        "lon": lon,
        "time": now_iso
    })
    _save_event_log()
    return jsonify({"status": "logged", "event_type": event_type})

# ===== DAILY SAFETY REPORT =====
@app.route('/api/daily-report')
def daily_report():
    """Aggregate last 24h events into a safety report."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    recent = [e for e in event_log if datetime.fromisoformat(e.get('time', '2000-01-01T00:00:00+00:00').replace('Z', '+00:00')) > cutoff]

    sos_count = sum(1 for e in recent if e.get('type') == 'sos')
    vision_count = sum(1 for e in recent if e.get('type') == 'vision')
    classroom_count = sum(1 for e in recent if e.get('type') == 'classroom')
    care_count = sum(1 for e in recent if e.get('type') == 'care_update')
    geofence_count = sum(1 for e in recent if e.get('type') == 'geofence')
    location_count = sum(1 for e in recent if e.get('type') == 'location')
    total = len(recent)

    # Compute last known location
    loc_events = [e for e in recent if e.get('lat')]
    last_loc = None
    if loc_events:
        last_loc = {"lat": loc_events[-1]['lat'], "lon": loc_events[-1]['lon']}

    return jsonify({
        "period": "24h",
        "total_events": total,
        "sos_alerts": sos_count,
        "vision_queries": vision_count,
        "classroom_events": classroom_count,
        "care_updates": care_count,
        "geofence_alerts": geofence_count,
        "location_updates": location_count,
        "last_location": last_loc,
        "safety_score": max(0, 100 - (sos_count * 30) - (geofence_count * 15))
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
