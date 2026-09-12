function propertyMap(properties) {
  return Object.fromEntries((properties || []).filter((item) => item?.name).map((item) => [item.name, item.value]));
}

function cycloneDxKey(component) {
  return component['bom-ref'] || component.purl || `${component.group ? `${component.group}/` : ''}${component.name}@${component.version || 'unknown'}`;
}

function spdxPurl(pkg) {
  return (pkg.externalRefs || []).find((ref) => ref.referenceType === 'purl')?.referenceLocator;
}

const AI_ENTITY_TYPES = new Set(['MODEL', 'DATASET', 'AI_FRAMEWORK', 'MODEL_PROVIDER', 'AI_APPLICATION', 'AI_AGENT']);

function cycloneDxEntityType(component, properties) {
  const declared = properties['bci:entityType']?.toUpperCase();
  if (declared && AI_ENTITY_TYPES.has(declared)) return declared;
  if (component.type === 'machine-learning-model') return 'MODEL';
  if (component.type === 'data') return 'DATASET';
  if (component.type === 'container') return 'CONTAINER';
  if (component.type === 'application') return 'ARTIFACT';
  return 'PACKAGE';
}

function modelCardAttributes(modelCard) {
  if (!modelCard || typeof modelCard !== 'object') return {};
  return {
    modelCard: {
      modelParameters: modelCard.modelParameters,
      considerations: modelCard.considerations,
      quantitativeAnalysis: modelCard.quantitativeAnalysis,
      properties: modelCard.properties,
    },
  };
}

export function normalizeSbomDocument(format, document) {
  if (!document || typeof document !== 'object') throw new Error('SBOM document must be an object');
  if (format === 'CYCLONEDX') {
    const components = Array.isArray(document.components) ? document.components : [];
    const entities = components.map((component) => {
      const properties = propertyMap(component.properties);
      return {
        type: cycloneDxEntityType(component, properties),
        key: cycloneDxKey(component),
        label: [component.name, component.version].filter(Boolean).join('@'),
        attributes: {
          format: 'CycloneDX', purl: component.purl, version: component.version,
          hashes: component.hashes, licenses: component.licenses,
          supplier: component.supplier, author: component.author,
          ...modelCardAttributes(component.modelCard),
          signed: properties['bci:signed'] === undefined ? undefined : properties['bci:signed'] === 'true',
          provenanceVerified: properties['bci:provenanceVerified'] === undefined ? undefined : properties['bci:provenanceVerified'] === 'true',
        },
      };
    });
    for (const service of document.services || []) {
      if (!service?.['bom-ref']) continue;
      entities.push({
        type: 'MODEL_PROVIDER', key: service['bom-ref'], label: service.name || service['bom-ref'],
        attributes: { format: 'CycloneDX', endpoints: service.endpoints, provider: service.provider },
      });
    }
    const entityByRef = new Map(entities.map((entity) => [entity.key, entity]));
    const relationships = [];
    for (const dependency of document.dependencies || []) {
      if (!entityByRef.has(dependency.ref)) continue;
      for (const dependsOn of dependency.dependsOn || []) {
        if (!entityByRef.has(dependsOn)) continue;
        relationships.push({ sourceType: entityByRef.get(dependency.ref).type, sourceKey: dependency.ref, targetType: entityByRef.get(dependsOn).type, targetKey: dependsOn, type: 'DEPENDS_ON', confidence: 100, evidence: { source: 'CycloneDX dependencies' } });
      }
    }
    return { entities, relationships };
  }
  if (format === 'SPDX') {
    const packages = Array.isArray(document.packages) ? document.packages : [];
    const entities = packages.filter((pkg) => pkg.SPDXID).map((pkg) => ({
      type: 'PACKAGE', key: pkg.SPDXID,
      label: [pkg.name, pkg.versionInfo].filter(Boolean).join('@'),
      attributes: { format: 'SPDX', purl: spdxPurl(pkg), version: pkg.versionInfo, checksums: pkg.checksums },
    }));
    const ids = new Set(entities.map((entity) => entity.key));
    const relationships = (document.relationships || [])
      .filter((relationship) => relationship.relationshipType === 'DEPENDS_ON' && ids.has(relationship.spdxElementId) && ids.has(relationship.relatedSpdxElement))
      .map((relationship) => ({ sourceType: 'PACKAGE', sourceKey: relationship.spdxElementId, targetType: 'PACKAGE', targetKey: relationship.relatedSpdxElement, type: 'DEPENDS_ON', confidence: 100, evidence: { source: 'SPDX relationships' } }));
    return { entities, relationships };
  }
  throw new Error(`unsupported SBOM format: ${format}`);
}

export function exportCycloneDx(entities, relationships) {
  const relevantTypes = new Set(['PACKAGE', 'ARTIFACT', 'CONTAINER', 'MODEL', 'DATASET', 'AI_FRAMEWORK', 'AI_APPLICATION', 'AI_AGENT', 'MODEL_PROVIDER']);
  const relevant = entities.filter((entity) => relevantTypes.has(entity.entity_type || entity.type));
  const refs = new Set(relevant.map((entity) => entity.external_key || entity.key));
  const componentType = (entity) => {
    const type = entity.entity_type || entity.type;
    if (type === 'MODEL') return 'machine-learning-model';
    if (type === 'DATASET') return 'data';
    if (type === 'CONTAINER') return 'container';
    if (['ARTIFACT', 'AI_APPLICATION', 'AI_AGENT'].includes(type)) return 'application';
    return 'library';
  };
  return {
    bomFormat: 'CycloneDX', specVersion: '1.7', version: 1,
    metadata: { properties: [{ name: 'bci:profile', value: 'AI/ML-BOM' }] },
    components: relevant.filter((entity) => (entity.entity_type || entity.type) !== 'MODEL_PROVIDER').map((entity) => ({
      type: componentType(entity),
      'bom-ref': entity.external_key || entity.key,
      name: entity.label,
      ...(entity.attributes?.version ? { version: entity.attributes.version } : {}),
      ...(entity.attributes?.purl ? { purl: entity.attributes.purl } : {}),
      ...((entity.entity_type || entity.type) === 'MODEL' && entity.attributes?.modelCard ? { modelCard: entity.attributes.modelCard } : {}),
      properties: [{ name: 'bci:entityType', value: entity.entity_type || entity.type }],
    })),
    services: relevant.filter((entity) => (entity.entity_type || entity.type) === 'MODEL_PROVIDER').map((entity) => ({
      'bom-ref': entity.external_key || entity.key, name: entity.label,
      ...(entity.attributes?.endpoints ? { endpoints: entity.attributes.endpoints } : {}),
    })),
    dependencies: relevant.map((entity) => {
      const ref = entity.external_key || entity.key;
      const dependsOn = relationships
        .filter((relationship) => (relationship.source_key || relationship.sourceKey) === ref)
        .filter((relationship) => ['DEPENDS_ON', 'TRAINED_ON', 'BUILT_WITH', 'PACKAGED_AS', 'RUNS_IN', 'POWERS', 'OPERATES', 'PROVIDED_BY'].includes(relationship.relationship_type || relationship.type))
        .map((relationship) => relationship.target_key || relationship.targetKey)
        .filter((target) => refs.has(target));
      return { ref, dependsOn };
    }),
  };
}

export function exportSpdx(entities, relationships) {
  const relevant = entities.filter((entity) => (entity.entity_type || entity.type) === 'PACKAGE');
  const refs = new Set(relevant.map((entity) => entity.external_key || entity.key));
  return {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: 'BCI exported SBOM',
    documentNamespace: `https://bci.local/sbom/${Date.now()}`,
    packages: relevant.map((entity) => ({
      SPDXID: entity.external_key || entity.key, name: entity.label,
      versionInfo: entity.attributes?.version || 'NOASSERTION', downloadLocation: 'NOASSERTION', filesAnalyzed: false,
    })),
    relationships: relationships
      .filter((relationship) => (relationship.relationship_type || relationship.type) === 'DEPENDS_ON')
      .filter((relationship) => refs.has(relationship.source_key || relationship.sourceKey) && refs.has(relationship.target_key || relationship.targetKey))
      .map((relationship) => ({ spdxElementId: relationship.source_key || relationship.sourceKey, relationshipType: 'DEPENDS_ON', relatedSpdxElement: relationship.target_key || relationship.targetKey })),
  };
}
