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
        
        phone = os.environ.get("FAMILY_PHONE")
        api_key = os.environ.get("FAST2SMS_KEY")
        
        maps_url = f"https://www.google.com/maps?q={lat},{lon}"
        message = f"SATHI SOS ALERT: User needs immediate help. Location: {maps_url}"

        self.logger.critical(f"SOS TRIGGERED: {trigger} at ({lat}, {lon})")

        # Attempt real SMS via Fast2SMS
        sms_sent = False
        sms_error = None

        if api_key and phone:
            try:
                self.logger.info(f"Sending SOS SMS to {phone} via Fast2SMS...")
                resp = httpx.post(
                    "https://www.fast2sms.com/dev/bulkV2",
                    headers={"authorization": api_key},
                    json={
                        "route": "q",
                        "message": message,
                        "language": "english",
                        "flash": 0,
                        "numbers": phone
                    },
                    timeout=10
                )
                result = resp.json()
                if result.get("return"):
                    sms_sent = True
                    self.logger.info(f"SMS sent successfully to {phone}")
                else:
                    sms_error = result.get("message", "Unknown Fast2SMS error")
                    self.logger.error(f"Fast2SMS error: {sms_error}")
            except httpx.TimeoutException:
                sms_error = "SMS request timed out"
                self.logger.error(sms_error)
            except Exception as e:
                sms_error = str(e)
                self.logger.error(f"SMS sending failed: {e}")
        else:
            missing = []
            if not api_key: missing.append("FAST2SMS_KEY")
            if not phone: missing.append("FAMILY_PHONE")
            sms_error = f"Missing env vars: {', '.join(missing)}"
            self.logger.warning(f"SMS not sent — {sms_error}")

        response = {
            "status": "success" if sms_sent else "partial",
            "message": "Guardian notified via SMS." if sms_sent else f"Emergency logged. SMS: {sms_error or 'not configured'}",
            "sms_sent": sms_sent,
            "location": {"lat": lat, "lon": lon},
            "maps_url": maps_url
        }

        return response
