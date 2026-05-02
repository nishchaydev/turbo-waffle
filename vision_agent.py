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

        system_prompt = f"""You are SATHI, a smart AI assistant for a visually impaired person.
Respond ONLY in {lang_name}. Keep it VERY CONCISE (max 2-3 sentences).
Focus on immediate hazards (stairs, obstacles, traffic) or answering the specific question.
Be direct and friendly.
IMPORTANT: If you have scene memory below, compare current scene with past scenes. If something looks familiar, mention it naturally like "This looks similar to the area you were in X minutes ago."{memory_section}"""

        user_content = user_query if user_query else "Describe what is directly in front of me for safe walking."

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
                    "max_tokens": 150,
                    "temperature": 0.3
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
