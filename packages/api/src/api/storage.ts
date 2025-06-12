import { getBackendUrl } from './base';

const downloadRecordings = (roomId: string): void => {
  const url = `${getBackendUrl()}/api/v1/storage/${roomId}/download`;
  const proxy = window.open(url, '_blank');
  // Close window after download completes
  setTimeout(() => {
    // Only close if status is 200
    if (proxy?.document.readyState === 'complete') {
      proxy?.close();
    }
  }, 1000);
};

export const storageApi = {
  downloadRecordings,
};
