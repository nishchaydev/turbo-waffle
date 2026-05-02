# Graph Report - Accessibility Companion Agent  (2026-05-02)

## Corpus Check
- 12 files · ~4,952 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 79 nodes · 101 edges · 12 communities detected
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]

## God Nodes (most connected - your core abstractions)
1. `run_demo()` - 8 edges
2. `speak()` - 8 edges
3. `routeVoiceCommand()` - 7 edges
4. `CoordinatorAgent` - 6 edges
5. `VoiceAgent` - 6 edges
6. `captureAndDescribe()` - 6 edges
7. `ReminderAgent` - 5 edges
8. `SoundDetectionAgent` - 5 edges
9. `SubtitleAgent` - 5 edges
10. `VisionAgent` - 5 edges

## Surprising Connections (you probably didn't know these)
- `goToCameraHUD()` --calls--> `getTranslation()`  [INFERRED]
  frontend\app.js → frontend\services\translations.js
- `run_demo()` --calls--> `CoordinatorAgent`  [INFERRED]
  main.py → coordinator_agent.py
- `run_demo()` --calls--> `VisionAgent`  [INFERRED]
  main.py → vision_agent.py
- `run_demo()` --calls--> `VoiceAgent`  [INFERRED]
  main.py → voice_agent.py
- `run_demo()` --calls--> `SubtitleAgent`  [INFERRED]
  main.py → subtitle_agent.py

## Communities

### Community 0 - "Community 0"
Cohesion: 0.18
Nodes (3): run_demo(), SOSAgent, SoundDetectionAgent

### Community 2 - "Community 2"
Cohesion: 0.28
Nodes (4): Attempts to listen for a voice command., Simplistic intent detection., Main run method. If input_data contains 'text', use it.          Otherwise, atte, VoiceAgent

### Community 3 - "Community 3"
Cohesion: 0.32
Nodes (5): captureGuideZoneFrame(), startRecognition(), stopAutoDescribe(), stopRecognition(), updateMicUI()

### Community 4 - "Community 4"
Cohesion: 0.33
Nodes (1): CoordinatorAgent

### Community 5 - "Community 5"
Cohesion: 0.33
Nodes (2): Process a transcript chunk sent from the frontend.         Uses Groq to generate, SubtitleAgent

### Community 6 - "Community 6"
Cohesion: 0.33
Nodes (2): Accepts input_data with:           - 'image': base64-encoded JPEG           - 'l, VisionAgent

### Community 7 - "Community 7"
Cohesion: 0.5
Nodes (1): ReminderAgent

### Community 8 - "Community 8"
Cohesion: 0.7
Nodes (5): captureAndDescribe(), routeVoiceCommand(), showAIBubble(), startAutoDescribe(), toggleFlashlight()

### Community 9 - "Community 9"
Cohesion: 0.5
Nodes (4): goToCameraHUD(), handleTilt(), setupRecognition(), speak()

### Community 10 - "Community 10"
Cohesion: 0.67
Nodes (2): detectObjects(), loadModel()

### Community 11 - "Community 11"
Cohesion: 0.67
Nodes (3): checkLowLight(), runCocoDetection(), startCocoDetection()

### Community 12 - "Community 12"
Cohesion: 1.0
Nodes (1): getTranslation()

## Knowledge Gaps
- **5 isolated node(s):** `Process a transcript chunk sent from the frontend.         Uses Groq to generate`, `Accepts input_data with:           - 'image': base64-encoded JPEG           - 'l`, `Attempts to listen for a voice command.`, `Simplistic intent detection.`, `Main run method. If input_data contains 'text', use it.          Otherwise, atte`
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 4`** (6 nodes): `CoordinatorAgent`, `.aggregate_responses()`, `.__init__()`, `.register_agent()`, `.route()`, `coordinator_agent.py`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 5`** (6 nodes): `Process a transcript chunk sent from the frontend.         Uses Groq to generate`, `SubtitleAgent`, `.__init__()`, `.process_transcript()`, `.run()`, `subtitle_agent.py`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 6`** (6 nodes): `Accepts input_data with:           - 'image': base64-encoded JPEG           - 'l`, `VisionAgent`, `.detect_objects()`, `.__init__()`, `.run()`, `vision_agent.py`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 7`** (5 nodes): `ReminderAgent`, `.add_reminder()`, `.__init__()`, `.run()`, `reminder_agent.py`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 10`** (4 nodes): `visionService.js`, `calculateDistance()`, `detectObjects()`, `loadModel()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 12`** (2 nodes): `translations.js`, `getTranslation()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `run_demo()` connect `Community 0` to `Community 2`, `Community 4`, `Community 5`, `Community 6`, `Community 7`?**
  _High betweenness centrality (0.251) - this node is a cross-community bridge._
- **Why does `VoiceAgent` connect `Community 2` to `Community 0`?**
  _High betweenness centrality (0.096) - this node is a cross-community bridge._
- **Why does `CoordinatorAgent` connect `Community 4` to `Community 0`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `run_demo()` (e.g. with `CoordinatorAgent` and `VisionAgent`) actually correct?**
  _`run_demo()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Process a transcript chunk sent from the frontend.         Uses Groq to generate`, `Accepts input_data with:           - 'image': base64-encoded JPEG           - 'l`, `Attempts to listen for a voice command.` to the rest of the system?**
  _5 weakly-connected nodes found - possible documentation gaps or missing edges._