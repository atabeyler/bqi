import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { apiErrorLabel, enumLabel, useLang } from '../i18n/LangContext.jsx';

const ASSET_TYPES = ['DOMAIN', 'HOST', 'WEB_APP', 'API', 'REPOSITORY', 'CONTAINER', 'CLOUD_RESOURCE', 'IDENTITY', 'SERVICE'];

export default function AssetsPage() {
  const { hasPermission } = useAuth();
  const { t } = useLang();
  const [assets, setAssets] = useState([]);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [assetType, setAssetType] = useState(ASSET_TYPES[0]);
  const [creating, setCreating] = useState(false);

  function load() {
    api.listAssets('ACTIVE').then((r) => setAssets(r.assets)).catch((err) => setError(apiErrorLabel(t, err)));
  }

  useEffect(load, [t]);

  async function onCreate(e) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.createAsset({ name, assetType });
      setName('');
      load();
    } catch (err) {
      setError(apiErrorLabel(t, err));
    } finally {
      setCreating(false);
    }
  }

  async function remove(asset) {
    if (!window.confirm(t('assetDeleteConfirm', { name: asset.name }))) return;
    setError(null);
    try {
      await api.archiveAsset(asset.id);
      load();
    } catch (err) {
      setError(apiErrorLabel(t, err));
    }
  }

  return (
    <div>
      <h2>{t('assetsTitle')}</h2>
      {error && <p className="error">{error}</p>}

      {hasPermission('asset:create') && (
        <form className="stack card" onSubmit={onCreate} style={{ flexDirection: 'row', alignItems: 'end', maxWidth: 'none' }}>
          <div>
            <label htmlFor="assetName">{t('assetNameLabel')}</label>
            <input id="assetName" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="assetType">{t('assetTypeLabel')}</label>
            <select id="assetType" value={assetType} onChange={(e) => setAssetType(e.target.value)}>
              {ASSET_TYPES.map((type) => <option key={type} value={type}>{enumLabel(t, 'assetType', type)}</option>)}
            </select>
          </div>
          <button type="submit" disabled={creating}>{t('addAssetBtn')}</button>
        </form>
      )}

      <table className="card">
        <thead>
          <tr><th>{t('colName')}</th><th>{t('colType')}</th><th>{t('colCriticality')}</th><th>{t('colActions')}</th></tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>{enumLabel(t, 'assetType', a.asset_type)}</td>
              <td>{enumLabel(t, 'criticality', a.criticality)}</td>
              <td>{hasPermission('asset:update') && <button className="secondary" onClick={() => remove(a)}>{t('deleteBtn')}</button>}</td>
            </tr>
          ))}
          {assets.length === 0 && <tr><td colSpan="4">{t('assetsEmpty')}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
