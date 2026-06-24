// API Client for making requests to the backend
export const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

// Get auth token from localStorage
function getAuthToken(): string | null {
  return localStorage.getItem('auth_token');
}

// Set auth token in localStorage
export function setAuthToken(token: string | null) {
  if (token) {
    localStorage.setItem('auth_token', token);
  } else {
    localStorage.removeItem('auth_token');
  }
}

// Make API request
export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
  const token = getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/Failed to fetch|Load failed|NetworkError|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NETWORK/i.test(msg)) {
      throw new Error('Connection failed. Is the server running? Try "npm run dev" in the project folder.');
    }
    throw err;
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  // Handle empty responses
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  
  return response.text() as any;
}

// GET request
export async function apiGet<T = any>(endpoint: string): Promise<T> {
  return apiRequest<T>(endpoint, { method: 'GET' });
}

// POST request
export async function apiPost<T = any>(endpoint: string, data?: any): Promise<T> {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  });
}

/** POST with JSON body; returns response as Blob (e.g. for TTS audio). */
export async function apiPostBlob(endpoint: string, data: Record<string, unknown>): Promise<Blob> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
  const token = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
    credentials: 'include',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error((error as { message?: string }).message || `HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim();
  if (contentType && (!blob.type || blob.type === 'application/octet-stream')) {
    const buffer = await blob.arrayBuffer();
    return new Blob([buffer], { type: contentType });
  }
  return blob;
}

// PUT request
export async function apiPut<T = any>(endpoint: string, data?: any): Promise<T> {
  return apiRequest<T>(endpoint, {
    method: 'PUT',
    body: data ? JSON.stringify(data) : undefined,
  });
}

// DELETE request
export async function apiDelete<T = any>(endpoint: string): Promise<T> {
  return apiRequest<T>(endpoint, { method: 'DELETE' });
}

// PATCH request
export async function apiPatch<T = any>(endpoint: string, data?: any): Promise<T> {
  return apiRequest<T>(endpoint, {
    method: 'PATCH',
    body: data ? JSON.stringify(data) : undefined,
  });
}

// Upload files
export async function apiUpload<T = any>(
  endpoint: string,
  formData: FormData
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
  const token = getAuthToken();

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}
