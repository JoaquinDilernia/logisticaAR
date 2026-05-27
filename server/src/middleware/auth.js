export function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Autenticación requerida' });
  }
  const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf-8');
  const [email, password] = decoded.split(':');
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    return next();
  }
  res.status(403).json({ error: 'Credenciales inválidas' });
}
