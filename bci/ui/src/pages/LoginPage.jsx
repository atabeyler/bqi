import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import { useLang } from '../i18n/LangContext.jsx';

export default function LoginPage() {
  const { login } = useAuth();
  const { t } = useLang();
  const navigate = useNavigate();
  const [orgSlug, setOrgSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(orgSlug, email, password);
      navigate('/');
    } catch (err) {
      setError(err.message || t('loginFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="stack card" onSubmit={onSubmit} style={{ width: 320 }}>
        <h2 style={{ margin: 0 }}>{t('loginTitle')}</h2>
        <div>
          <label htmlFor="orgSlug">{t('loginOrganization')}</label>
          <input id="orgSlug" value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} required autoFocus />
        </div>
        <div>
          <label htmlFor="email">{t('loginEmail')}</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="password">{t('loginPassword')}</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? t('loginSigningIn') : t('loginSignIn')}
        </button>
      </form>
    </div>
  );
}
