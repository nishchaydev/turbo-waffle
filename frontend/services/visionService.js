// Vision Service — COCO-SSD object detection + distance estimation

let model = null;

const loadModel = async () => {
    if (!model) {
        model = await cocoSsd.load();
    }
    return model;
};

export const detectObjects = async (videoElement) => {
    const model = await loadModel();
    const predictions = await model.detect(videoElement);

    // Increased threshold for high accuracy (prevents hallucinating 'train' for pillars)
    return predictions.filter(p => p.score > 0.60);
};
