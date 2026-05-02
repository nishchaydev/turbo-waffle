export const translations = {
    'en-US': { promptLang: "I'm SATHI, your accessibility companion. I'll describe your surroundings automatically.", msgSOS: "SOS alert has been sent to your guardian!" },
    'hi-IN': { promptLang: "मैं साथी हूँ, आपका सहायक। मैं आपके आसपास का वर्णन करूँगा।", msgSOS: "आपके अभिभावक को SOS भेजा गया!" },
    'mr-IN': { promptLang: "मी साथी आहे, तुमचा सहायक. मी तुमच्या आजूबाजूचे वर्णन करेन.", msgSOS: "तुमच्या पालकांना SOS पाठवला!" },
    'ta-IN': { promptLang: "நான் சாதி, உங்கள் உதவியாளர். உங்கள் சுற்றுப்புறத்தை விவரிக்கிறேன்.", msgSOS: "உங்கள் காவலருக்கு SOS அனுப்பப்பட்டது!" },
    'bn-IN': { promptLang: "আমি সাথী, আপনার সহায়ক। আমি আপনার চারপাশ বর্ণনা করব।", msgSOS: "আপনার অভিভাবককে SOS পাঠানো হয়েছে!" },
    'gu-IN': { promptLang: "હું સાથી છું, તમારો સહાયક. હું તમારી આસપાસનું વર્ણન કરીશ.", msgSOS: "તમારા વાલીને SOS મોકલવામાં આવ્યો!" },
    'ur-IN': { promptLang: "میں ساتھی ہوں، آپ کا معاون۔ میں آپ کے ماحول کی وضاحت کروں گا۔", msgSOS: "آپ کے سرپرست کو SOS بھیجا گیا!" }
};

export const getTranslation = (lang, key) => {
    return translations[lang]?.[key] || translations['en-US'][key] || '';
};
