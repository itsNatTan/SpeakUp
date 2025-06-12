const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const lower = 'abcdefghijklmnopqrstuvwxyz';
const numeric = '0123456789';

const generateFromSrc = (src: string, length: number): string => {
  return Array.from(
    { length },
    () => src[Math.floor(Math.random() * src.length)],
  ).join('');
};

export default {
  generateUppercase: (length: number) => generateFromSrc(upper, length),
  generateLowercase: (length: number) => generateFromSrc(lower, length),
  generateNumeric: (length: number) => generateFromSrc(numeric, length),
};
