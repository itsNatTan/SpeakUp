export const msToHMS = (ms: number): [number, number, number] => {
  const hours = Math.floor(ms / 3600_000);
  const minutes = Math.floor((ms % 3600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return [hours, minutes, seconds];
};
