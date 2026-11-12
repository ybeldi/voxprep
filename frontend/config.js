// Use same-origin when cloned and run locally on localhost / 127.0.0.1;
// point hosted frontend deployments (e.g. Vercel) to the Render backend.
const isLocalOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
window.VOXPREP_API_BASE = isLocalOrigin ? '' : 'https://voxprep-kjep.onrender.com';

