/**
 * @typedef {{
 *   name: string,
 *   reusable?: boolean,
 *   app_count?: number,
 * }} PolicySummary
 */

/**
 * @typedef {{
 *   name: string,
 *   decision: string,
 *   precedence: number,
 *   include: Array<Record<string, Record<string, string>>>,
 * }} DesiredPolicy
 */

/**
 * @param {string} ownerEmail
 * @param {string} employeeEmailDomain
 * @returns {DesiredPolicy}
 */
export function ownerApplicationPolicy(ownerEmail, employeeEmailDomain) {
  return {
    name: 'Allow Streamline owner and employees',
    decision: 'allow',
    precedence: 1,
    include: [
      { email: { email: ownerEmail } },
      { email_domain: { domain: employeeEmailDomain } },
    ],
  }
}

/**
 * @template {PolicySummary} T
 * @param {T[]} policies
 * @param {{ name: string }} desired
 * @param {string[]} previousNames
 */
export function planPolicyReconciliation(policies, desired, previousNames = []) {
  const previousNameSet = new Set(previousNames)
  const matching = policies.find((policy) => policy.name === desired.name)
    ?? policies.find((policy) => previousNameSet.has(policy.name))
  return {
    matching,
    obsolete: policies.filter((policy) => policy !== matching),
  }
}

/**
 * @param {string} applicationId
 * @param {{ id: string, reusable?: boolean }} current
 * @param {DesiredPolicy} desired
 */
export function policyUpdateRequest(applicationId, current, desired) {
  if (current.reusable) {
    const { precedence: _precedence, ...body } = desired
    return { path: `/access/policies/${current.id}`, body }
  }
  return {
    path: `/access/apps/${applicationId}/policies/${current.id}`,
    body: desired,
  }
}

/**
 * @param {{
 *   policies: PolicySummary[],
 *   matching?: PolicySummary,
 *   obsolete: PolicySummary[],
 * }} plan
 */
export function policyPlanBlockers(plan) {
  const blockers = []
  if (!plan.matching && plan.policies.length) {
    blockers.push(`no managed policy found among: ${plan.policies.map((policy) => policy.name).join(', ')}`)
  }
  if (plan.matching?.reusable && plan.matching.app_count !== 1) {
    blockers.push(`${plan.matching.name} is reusable across ${String(plan.matching.app_count)} applications`)
  }
  const reusableObsolete = plan.obsolete.filter((policy) => policy.reusable)
  if (reusableObsolete.length) {
    blockers.push(`additional reusable policies require manual detachment: ${reusableObsolete.map((policy) => policy.name).join(', ')}`)
  }
  return blockers
}
