// Test harness only: an operator explicitly registers the owned fixture origin.
export function authorizeLab(target) {
  const origin=new URL(target).origin;
  const previous=process.env.BCI_NATIVE_LAB_ORIGINS || '';
  process.env.BCI_NATIVE_LAB_ORIGINS=[...new Set([...previous.split(',').filter(Boolean),origin])].join(',');
  return ()=>{process.env.BCI_NATIVE_LAB_ORIGINS=previous;};
}
