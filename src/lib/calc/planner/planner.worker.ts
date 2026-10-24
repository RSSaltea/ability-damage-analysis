import { searchRotations } from './planner';
let cancelled = false;
self.onmessage = async ({ data }) => {
    if (data.type === 'stop') {
        cancelled = true;
        return;
    }
    cancelled = false;
    try {
        const result = await searchRotations(
            data.input,
            (progress) => self.postMessage({ type: 'progress', ...progress }),
            () => cancelled
        );
        self.postMessage({ type: 'done', ...result });
    } catch (error) {
        self.postMessage({ type: 'error', error: String(error) });
    }
};
