import httpx
import os
import logging

class SOSAgent:
    def __init__(self):
        logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        self.logger = logging.getLogger("SOSAgent")

    def run(self, params):
        trigger = params.get("trigger", "manual")
        lat = params.get("latitude", "22.7196")
        lon = params.get("longitude", "75.8577")
        
        email = params.get("email") or os.environ.get("FAMILY_EMAIL", "ac.nishchay@gmail.com")
        api_key = os.environ.get("RESEND_API_KEY", "re_XmVNfaEX_BswxYkp5DSHCRYwAUXdYeX9G")
        
        maps_url = f"https://www.google.com/maps?q={lat},{lon}"
        html_message = f"<h2>🚨 SATHI SOS ALERT 🚨</h2><p>User needs immediate help.</p><p>Location: <a href='{maps_url}'>{maps_url}</a></p>"

        self.logger.critical(f"SOS TRIGGERED: {trigger} at ({lat}, {lon})")

        # Attempt real Email via Resend
        email_sent = False
        email_error = None

        if api_key and email:
            try:
                self.logger.info(f"Sending SOS Email to {email} via Resend...")
                json_payload = {
                    "from": "SATHI SOS <sos@mail.emitra.dev>",
                    "to": [email],
                    "subject": "🚨 SATHI SOS ALERT 🚨",
                    "html": html_message
                }
                
                photo = params.get("photo")
                if photo:
                    # Strip base64 prefix if present
                    b64_content = photo.split(",")[1] if "," in photo else photo
                    json_payload["attachments"] = [
                        {
                            "filename": "sos_scene.jpg",
                            "content": b64_content
                        }
                    ]

                resp = httpx.post(
                    "https://api.resend.com/emails",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json"
                    },
                    json=json_payload,
                    timeout=10
                )
                result = resp.json()
                if resp.status_code in (200, 201):
                    email_sent = True
                    self.logger.info(f"Email sent successfully to {email}. ID: {result.get('id')}")
                else:
                    email_error = result.get("message", "Unknown Resend error")
                    self.logger.error(f"Resend error: {email_error}")
            except httpx.TimeoutException:
                email_error = "Email request timed out"
                self.logger.error(email_error)
            except Exception as e:
                email_error = str(e)
                self.logger.error(f"Email sending failed: {e}")
        else:
            missing = []
            if not api_key: missing.append("RESEND_API_KEY")
            if not email: missing.append("FAMILY_EMAIL")
            email_error = f"Missing env vars: {', '.join(missing)}"
            self.logger.warning(f"Email not sent — {email_error}")

        response = {
            "status": "success" if email_sent else "partial",
            "message": "Guardian notified via Email." if email_sent else f"Emergency logged. Email: {email_error or 'not configured'}",
            "email_sent": email_sent,
            "location": {"lat": lat, "lon": lon},
            "maps_url": maps_url
        }

        return response
