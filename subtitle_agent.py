import httpx
import os
import logging

class SubtitleAgent:
    def __init__(self):
        logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        self.logger = logging.getLogger("SubtitleAgent")
        self.is_running = False

    def run(self, input_data):
        action = input_data.get("action", "start")
        
        if action == "start":
            self.is_running = True
            self.logger.info("[Subtitle Agent] Live subtitles enabled.")
            return "SUCCESS: Live subtitles enabled. Listening for speech..."
        elif action == "stop":
            self.is_running = False
            return "SUCCESS: Subtitles disabled."
        elif action == "transcribe":
            # This is the old polling endpoint — now real transcription happens client-side
            # Return current status
            if self.is_running:
                return "Listening for speech... (transcription active on device)"
            return "Subtitles paused. Tap Start to begin."

        return "INFO: Subtitle agent ready."

    def process_transcript(self, transcript, language="en"):
        """
        Process a transcript chunk sent from the frontend.
        Uses Groq to generate a contextual response/summary for hearing-impaired users.
        """
        api_key = os.environ.get("GROQ_API_KEY")
        
        if not api_key:
            self.logger.warning("GROQ_API_KEY not set. Returning raw transcript.")
            return {"summary": transcript, "response": ""}

        if not transcript or len(transcript.strip()) < 5:
            return {"summary": "", "response": ""}

        try:
            self.logger.info(f"[Subtitle Agent] Processing transcript ({len(transcript)} chars)...")
            
            lang_name = {
                "en-US": "English", "hi-IN": "Hindi", "mr-IN": "Marathi",
                "ta-IN": "Tamil", "bn-IN": "Bengali", "gu-IN": "Gujarati", "ur-IN": "Urdu"
            }.get(language, "English")

            response = httpx.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": "meta-llama/llama-4-scout-17b-16e-instruct",
                    "messages": [{
                        "role": "system",
                        "content": f"You are an assistant helping a deaf or hearing-impaired person understand conversations. Respond in {lang_name}. Be concise — 1-2 sentences max."
                    }, {
                        "role": "user",
                        "content": f"Someone just said: \"{transcript}\"\n\nBriefly summarize the key point and any action the user should take."
                    }],
                    "max_tokens": 100
                },
                timeout=10
            )

            data = response.json()

            if response.status_code != 200:
                error_msg = data.get("error", {}).get("message", "API error")
                self.logger.error(f"Groq error: {error_msg}")
                return {"summary": transcript, "response": f"(AI unavailable: {error_msg})"}

            ai_response = data["choices"][0]["message"]["content"]
            self.logger.info(f"[Subtitle Agent] AI response: {ai_response}")
            return {"summary": transcript, "response": ai_response}

        except Exception as e:
            self.logger.error(f"Subtitle processing error: {e}")
            return {"summary": transcript, "response": ""}
