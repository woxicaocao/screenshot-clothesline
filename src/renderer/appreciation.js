'use strict';
const qr = document.getElementById('appreciationQr');
qr.addEventListener('error', () => { qr.hidden = true; document.getElementById('qrError').hidden = false; });
const close = () => window.appreciation.close().catch(() => {});
document.getElementById('closeButton').addEventListener('click', close);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); close(); }
});
