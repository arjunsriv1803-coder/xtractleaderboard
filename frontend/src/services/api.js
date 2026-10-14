const getBaseUrl = () => {
  const envUrl = (import.meta.env.VITE_API_URL || '').trim();
  if (envUrl && envUrl !== 'http://localhost:5000') {
    return envUrl;
  }
  return envUrl || 'http://localhost:5000';
};

const rawUrl = getBaseUrl().replace(/\/+$/, '');
export const SERVER_URL = rawUrl.replace(/\/api$/, '');
export const API_BASE = `${SERVER_URL}/api`;
export const WS_URL = `${SERVER_URL.replace(/^http/, 'ws')}/ws/leaderboard`;

const request = async (endpoint, options = {}) => {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const response = await fetch(`${API_BASE}${cleanEndpoint}`, {
    ...options,
    headers,
    cache: 'no-store'
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.message ||
      (typeof data.error === 'string' ? data.error : null) ||
      'API request failed'
    );
    error.status = response.status;
    throw error;
  }

  return data;
};

export const api = {
  getLeaderboard: () => request('/leaderboard'),
};
