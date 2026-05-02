// Vision Service — COCO-SSD object detection + distance estimation

let model = null;

const loadModel = async () => {
    if (!model) {
        model = await cocoSsd.load();
    }
    return model;
};

// Real-world height in meters for common objects
const OBJECT_HEIGHTS = {
    'person': 1.7,
    'chair': 1.0,
    'table': 0.75,
    'dining table': 0.75,
    'bottle': 0.25,
    'laptop': 0.3,
    'cell phone': 0.15,
    'cup': 0.1,
    'book': 0.2,
    'mouse': 0.1,
    'keyboard': 0.4,
    'backpack': 0.5,
    'handbag': 0.3,
    'suitcase': 0.6,
    'bowl': 0.1,
    'potted plant': 0.4,
    'dog': 0.5,
    'cat': 0.3,
    'car': 1.5,
    'bus': 3.0,
    'truck': 2.5,
    'bicycle': 1.0,
    'motorcycle': 1.1,
    'traffic light': 0.6,
    'stop sign': 0.75,
    'bench': 0.5,
    'umbrella': 0.9,
    'scissors': 0.15,
    'remote': 0.15,
    'tv': 0.6,
    'monitor': 0.5,
    'vase': 0.25,
    'clock': 0.25,
    'knife': 0.2,
    'fork': 0.15,
    'spoon': 0.15,
    'banana': 0.15,
    'apple': 0.08,
    'orange': 0.08,
    'sandwich': 0.1,
    'pizza': 0.3,
    'bed': 0.6,
    'toilet': 0.4,
    'refrigerator': 1.7,
    'oven': 0.9,
    'microwave': 0.3,
    'toaster': 0.2,
    'sink': 0.3,
    'fire hydrant': 0.5,
};

// Focal length estimation
const FOCAL_LENGTH = 600;

export const calculateDistance = (bbox, label) => {
    const pixelHeight = bbox[3];
    const realHeight = OBJECT_HEIGHTS[label] || 0.3;
    const distance = (realHeight * FOCAL_LENGTH) / pixelHeight;
    return distance.toFixed(1);
};

export const detectObjects = async (videoElement) => {
    const model = await loadModel();
    const predictions = await model.detect(videoElement);

    // Lowered threshold to catch small objects
    const enhanced = predictions
        .filter(p => p.score > 0.35)
        .map(p => ({
            ...p,
            distance: calculateDistance(p.bbox, p.class)
        }));

    return enhanced;
};
