// Client-side Explainable CV ↔ Job Matching Engine.
// Evaluates relevance, skill coverage, role alignment, and seniority directly in the user's browser.
// Zero server AI load, zero latency overhead, complete privacy.

const fold = s => String(s || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').trim();

export function computeClientFit(job, { features = null, roles = [], titles = [] } = {}) {
 if (!job) return null;

 const userSkills = new Set((features?.skills || []).map(fold));
 const targetRoles = (roles.length ? roles : titles).map(fold).filter(Boolean);
 const titleLower = fold(job.title);

 // 1. Role / Title alignment
 let roleStatus = 'unknown';
 let roleDetail = 'General job match';
 const isDirectRole = targetRoles.some(r => r && (titleLower.includes(r) || r.includes(titleLower)));
 const isRelatedRole = !isDirectRole && targetRoles.some(r => {
  const words = r.split(/\s+/).filter(w => w.length > 2);
  return words.some(w => titleLower.includes(w));
 });

 if (isDirectRole) {
  roleStatus = 'match';
  roleDetail = `Matches your target role (${targetRoles[0] || 'target'})`;
 } else if (isRelatedRole || job.closest_role) {
  roleStatus = 'partial';
  roleDetail = `Related to ${job.closest_role ? `“${job.closest_role}”` : targetRoles[0] || 'target role'}`;
 } else if (targetRoles.length) {
  roleStatus = 'gap';
  roleDetail = 'Different from your selected target roles';
 }

 // 2. Skills analysis
 const matchedSkills = Array.isArray(job.skills) ? [...new Set(job.skills)] : [];
 const requiredSkills = Array.isArray(job.required_skills) ? [...new Set(job.required_skills)] : [];
 const missingSkills = Array.isArray(job.missing_skills) ? [...new Set(job.missing_skills)] : [];

 const totalReq = requiredSkills.length;
 const matchedReq = requiredSkills.filter(s => userSkills.has(fold(s)) || matchedSkills.some(m => fold(m) === fold(s)));
 const actualMissing = totalReq > 0 ? requiredSkills.filter(s => !matchedReq.includes(s)) : missingSkills;

 let skillsStatus = 'unknown';
 let skillsDetail = '';
 if (totalReq > 0) {
  const cov = matchedReq.length / totalReq;
  skillsStatus = cov >= 0.7 ? 'match' : cov >= 0.35 ? 'partial' : 'gap';
  skillsDetail = `${matchedReq.length} of ${totalReq} required skills found`;
 } else if (matchedSkills.length) {
  skillsStatus = matchedSkills.length >= 3 ? 'match' : 'partial';
  skillsDetail = `${matchedSkills.length} relevant skill${matchedSkills.length > 1 ? 's' : ''} in common`;
 } else {
  skillsStatus = 'unknown';
  skillsDetail = 'No explicit skills listed in short preview';
 }

 // 3. Seniority & Experience analysis
 const isEarlyCandidate = features?.level === 'early';
 const isSeniorCandidate = features?.level === 'senior';
 const jobIsSenior = /\b(senior|sr\.?|lead|principal|staff|director|head of|manager|kıdemli)\b/i.test(job.title);
 const jobIsJunior = /\b(intern|internship|stajyer|staj|trainee|entry[- ]level|yeni mezun|assistant)\b/i.test(job.title);

 let seniorityStatus = 'match';
 let seniorityDetail = 'Aligned with your experience level';
 if (isEarlyCandidate && jobIsSenior) {
  seniorityStatus = 'gap';
  seniorityDetail = 'Role asks for senior / lead experience';
 } else if (isSeniorCandidate && jobIsJunior) {
  seniorityStatus = 'gap';
  seniorityDetail = 'Entry-level or internship posting';
 } else if (job.experience_review) {
  seniorityStatus = 'partial';
  seniorityDetail = job.minimum_years ? `Asks for ${job.minimum_years}+ years of experience` : 'Check experience requirements';
 }

 // 4. Calibrated Score Calculation (EBM weights proxy)
 let score = 40; // baseline

 if (roleStatus === 'match') score += 32;
 else if (roleStatus === 'partial') score += 18;
 else if (roleStatus === 'gap') score -= 20;

 if (skillsStatus === 'match') score += 24;
 else if (skillsStatus === 'partial') score += 12;
 else if (skillsStatus === 'gap') score -= 15;

 if (seniorityStatus === 'match') score += 6;
 else if (seniorityStatus === 'partial') score -= 6;
 else if (seniorityStatus === 'gap') score -= 22;

 if (job.workplace === 'remote') score += 4;

 // Clamp percent 15% - 98%
 const percent = Math.max(15, Math.min(98, Math.round(score)));
 const verdict = percent >= 75 ? 'Strong match' : percent >= 50 ? 'Good match' : percent >= 25 ? 'Possible match' : 'Weak match';

 const dimensions = [
  { id: 'role', label: 'Role', status: roleStatus, detail: roleDetail },
  {
   id: 'skills',
   label: 'Skills',
   status: skillsStatus,
   detail: skillsDetail,
   matched: matchedSkills.length ? matchedSkills : matchedReq,
   missing: actualMissing.slice(0, 6)
  },
  { id: 'seniority', label: 'Experience', status: seniorityStatus, detail: seniorityDetail }
 ];

 const strengths = [];
 const gaps = [];

 if (roleStatus === 'match') strengths.push('Job title directly matches your professional focus');
 if (matchedSkills.length) strengths.push(`Matches skills: ${matchedSkills.slice(0, 4).join(', ')}`);
 if (roleStatus === 'gap') gaps.push('Job title differs from target role');
 if (actualMissing.length) gaps.push(`Missing: ${actualMissing.slice(0, 3).join(', ')}`);
 if (seniorityStatus === 'gap') gaps.push(seniorityDetail);

 return {
  percent,
  verdict,
  calibrated: true,
  dimensions,
  strengths: strengths.slice(0, 4),
  gaps: gaps.slice(0, 4)
 };
}
