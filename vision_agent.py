import httpx
import os
import logging

# Language code to name mapping for prompt construction
LANG_NAMES = {
    'en-US': 'English',
    'hi-IN': 'Hindi',
    'mr-IN': 'Marathi',
    'ta-IN': 'Tamil',
    'bn-IN': 'Bengali',
    'gu-IN': 'Gujarati',
    'ur-IN': 'Urdu',
}

class VisionAgent:
    def __init__(self):
        logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        self.logger = logging.getLogger("VisionAgent")
        self.api_key = os.environ.get("GROQ_API_KEY")
        if not self.api_key:
            self.logger.warning("GROQ_API_KEY not set. Vision will return fallback responses.")

    def run(self, input_data):
        """
        Accepts input_data with:
          - 'image': base64-encoded JPEG
          - 'language': language code (e.g. 'hi-IN') — optional, defaults to 'en-US'
          - 'query': specific user question — optional
          - 'memory': scene memory context — optional
        Sends to Groq Vision API with a conversational, accessibility-focused prompt.
        """
        api_key = os.environ.get("GROQ_API_KEY")
        image_b64 = input_data.get("image")
        language = input_data.get("language", "en-US")
        user_query = input_data.get("query", None)
        memory_ctx = input_data.get("memory", "")
        lang_name = LANG_NAMES.get(language, "English")

        if not api_key:
            self.logger.error("GROQ_API_KEY is not configured.")
            return "Vision service not configured. Please set GROQ_API_KEY."

        if not image_b64:
            return "Please point camera at something and capture a frame."

        self.logger.info(f"[Vision Agent] Sending frame to Groq Vision API (language={lang_name}, memory={len(memory_ctx)}chars)...")

        # Build the accessibility-focused prompt with scene memory
        memory_section = ""
        if memory_ctx:
            memory_section = f"\n\n{memory_ctx}"

        system_prompt = f"""You are SATHI, AI safety eyes for a 
visually impaired person who CANNOT see anything.

YOUR #1 JOB: Keep them SAFE. Warn about dangers first.

PRIORITY ORDER (always follow):
1. IMMEDIATE DANGER: wall ahead, stairs, 
   drop-off, curb, vehicle, hole, wet floor
2. COLLISION RISK: any obstacle in direct 
   walking path (door frame, pillar, pole, 
   furniture, glass door/wall)
3. NAVIGATION: open door, turn, corridor, 
   ramp, crossing
4. CONTEXT: room type, people, signs

STRICT RULES:
1. Max 2 sentences. First sentence = danger.
2. NEVER estimate or mention distance or proximity. 
3. NEVER use words like "near", "far", "close", "meters", "feet", "steps away", "approximately", "around".
4. Use body-relative directions: 
   "directly ahead", "to your left/right", 
   "at your feet", "above your head"
5. If wall or dead-end ahead: ALWAYS say it.
6. If stairs/steps visible: say UP or DOWN 
   and warn immediately.
7. If floor changes (carpet to tile, dry to 
   wet, level to slope): mention it.
8. If nothing dangerous: "Clear path ahead."
9. No greetings. No "I can see". Just facts.

CRITICAL HAZARDS (never miss these):
- Stairs/steps going DOWN (drop-offs)
- Stairs/steps going UP
- Curbs and drop-offs
- Walls and dead ends
- Glass doors/walls (invisible barriers)
- Wet/slippery floors
- Uneven ground or potholes
- Moving vehicles or bicycles

GOOD: "Wall directly ahead. Turn right for 
open corridor."
GOOD: "Stairs going DOWN, 3 steps. Hold 
the railing on your right."
GOOD: "Glass door ahead, closed. Handle on 
your right."
BAD: "I can see a nice hallway with..."

Respond in {lang_name} only."""

        user_content = user_query if user_query else "Look exactly at the floor and walking path. Are there stairs going DOWN? Are there any drop-offs, walls, or curbs? Describe the immediate path for safe walking."

        try:
            response = httpx.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": "meta-llama/llama-4-scout-17b-16e-instruct",
                    "messages": [
                        {
                            "role": "system",
                            "content": system_prompt
                        },
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": user_content
                                },
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:image/jpeg;base64,{image_b64}"
                                    }
                                }
                            ]
                        }
                    ],
                    "max_tokens": 100,
                    "temperature": 0.1
                },
                timeout=20
            )

            data = response.json()

            if response.status_code != 200:
                error_msg = data.get("error", {}).get("message", "Unknown API error")
                self.logger.error(f"Groq API error: {error_msg}")
                return f"Vision error: {error_msg}"

            description = data["choices"][0]["message"]["content"]
            self.logger.info(f"[Vision Agent] Description: {description}")
            return description

        except httpx.TimeoutException:
            self.logger.error("Groq API request timed out.")
            return "Vision request timed out. Please try again."
        except Exception as e:
            self.logger.error(f"Vision Agent error: {e}")
            return f"Vision error: {str(e)}"

    def detect_objects(self, frame):
        # Legacy stub — client-side COCO-SSD handles real-time object detection
        return []
