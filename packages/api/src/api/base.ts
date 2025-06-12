import axios, { AxiosRequestConfig } from 'axios';

const defaultBackendUrl = 'http://localhost:8000';
let backendUrl = defaultBackendUrl;

export const setBackendUrl = (url: string | undefined) => {
  backendUrl = url || defaultBackendUrl;
};

/** For internal use only. */
export const getBackendUrl = () => backendUrl;

const client = axios.create({
  headers: {
    'Content-Type': 'application/json',
  },
});

const getAxiosConfig = (): AxiosRequestConfig => {
  const host = backendUrl;
  // Default config
  const config: AxiosRequestConfig = {
    baseURL: host,
    headers: {
      Accept: 'application/json',
    },
  };
  return config;
};

export default {
  get: async (url: string, config?: AxiosRequestConfig) => {
    return client.get(url, { ...getAxiosConfig(), ...config });
  },
  post: async (url: string, data?: any, config?: AxiosRequestConfig) => {
    return client.post(url, data, { ...getAxiosConfig(), ...config });
  },
  put: async (url: string, data?: any, config?: AxiosRequestConfig) => {
    return client.put(url, data, { ...getAxiosConfig(), ...config });
  },
  delete: async (url: string, config?: AxiosRequestConfig) => {
    return client.delete(url, { ...getAxiosConfig(), ...config });
  },
};
