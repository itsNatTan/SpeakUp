import { atom } from 'nanostores';

const $username = atom<string | null>(null);

export const store = {
  setUsername: $username.set,
  getUsername: $username.get,
};
