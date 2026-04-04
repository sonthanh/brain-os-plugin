#!/usr/bin/env python3
"""Score agent answers vs NLM answers. Outputs JSONL with scores."""

import json, os, re

base = '/Users/thanhdo/work/brain/knowledge/raw/the-road-less-stupid'

# Load notes
notes = {}
for root, dirs, files in os.walk(base):
    for f in files:
        if f.endswith('.md'):
            content = open(os.path.join(root, f)).read()
            slug = f.replace('.md', '')
            # Extract body (skip frontmatter)
            if '---' in content:
                parts = content.split('---', 2)
                if len(parts) >= 3:
                    content = parts[2].strip()
            notes[slug] = content

# Topic to slug mapping
topic_map = {
    'cross-cutting': None,
    'big-eight': 'the-big-eight',
    'enterprise-value': 'creating-enterprise-value',
    'risk': 'not-all-risks-are-created-equal',
    'planning': 'its-not-about-the-plan',
    'mann-gulch': 'mann-gulch-lessons',
    'kool-aid': 'kool-aid-conventional-wisdom',
    'sandi-story': 'pleasure-vs-happiness',
    'ceo-jobs': 'ceo-non-delegable-jobs',
    'apology': 'the-apology',
    'business-model': 'correcting-business-model',
    'everything-counts': 'ordinary-things-consistently-done',
    'second-half': 'how-to-play-second-half',
    'assumptions': 'check-assumptions',
    'measuring': 'what-gets-measured',
    'einstein': 'advantage-of-being-small',
    'owner-job': 'you-inc',
    'three-pillars': 'three-pillars-of-success',
    'bernoulli': 'pleasure-vs-happiness',
    'indigestion': 'indigestion-not-starvation',
    'tyson': 'its-not-about-the-plan',
}

# Load NLM answers
answers = []
with open('/tmp/self-learn-answers.jsonl') as f:
    for line in f:
        answers.append(json.loads(line))

def get_agent_answer(topic):
    slug = topic_map.get(topic, topic)
    if slug and slug in notes:
        return notes[slug]
    return None

def simple_score(agent_text, nlm_text, question):
    """Heuristic scoring based on key term overlap and content match."""
    if not agent_text:
        return 50, "No matching note found"

    # Extract key terms from NLM answer (words 4+ chars, not common)
    common = {'that', 'this', 'with', 'from', 'they', 'their', 'which', 'have',
              'been', 'were', 'will', 'would', 'could', 'should', 'about', 'when',
              'what', 'your', 'into', 'than', 'them', 'more', 'also', 'just',
              'only', 'very', 'most', 'does', 'each', 'much', 'some', 'many',
              'because', 'being', 'other', 'these', 'those', 'such', 'like',
              'make', 'over', 'then', 'made', 'after', 'before', 'while'}

    nlm_words = set(w.lower().strip('.,;:!?"\'()[]') for w in nlm_text.split()
                     if len(w) > 3 and w.lower() not in common)
    agent_words = set(w.lower().strip('.,;:!?"\'()[]') for w in agent_text.split()
                       if len(w) > 3 and w.lower() not in common)

    if not nlm_words:
        return 85, "NLM answer too short to compare"

    overlap = nlm_words & agent_words
    coverage = len(overlap) / len(nlm_words) if nlm_words else 0

    # Base score from overlap
    score = min(98, int(50 + coverage * 50))

    # Bonus for matching key concepts (names, numbers, specific terms)
    key_patterns = re.findall(r'\b(?:Point [AB]|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|\d+(?:\.\d+)?)\b', nlm_text)
    matched_keys = sum(1 for p in key_patterns if p.lower() in agent_text.lower())
    if key_patterns:
        key_ratio = matched_keys / len(key_patterns)
        score = int(score * 0.7 + key_ratio * 30)

    missing = nlm_words - agent_words
    top_missing = sorted(missing, key=lambda w: len(w), reverse=True)[:5]

    return score, f"Missing terms: {', '.join(top_missing)}" if top_missing else "Good coverage"

# Score all
results = []
for a in answers:
    agent_text = get_agent_answer(a['topic'])
    score, detail = simple_score(agent_text, a['nlm_answer'], a['question'])

    results.append({
        'id': a['id'],
        'type': a['type'],
        'topic': a['topic'],
        'question': a['question'],
        'score': score,
        'pass': score >= 90,
        'detail': detail,
    })

# Write results
with open('/tmp/self-learn-scores.jsonl', 'w') as f:
    for r in results:
        f.write(json.dumps(r, ensure_ascii=False) + '\n')

# Summary
passed = sum(1 for r in results if r['pass'])
failed = [r for r in results if not r['pass']]
avg_score = sum(r['score'] for r in results) / len(results)

print(f"=== VALIDATION RESULTS ===")
print(f"Total questions: {len(results)}")
print(f"Passed (>=90): {passed}/{len(results)} ({passed*100//len(results)}%)")
print(f"Failed (<90):  {len(failed)}/{len(results)}")
print(f"Average score: {avg_score:.1f}")
print()

if failed:
    print(f"=== FAILED QUESTIONS ({len(failed)}) ===")
    # Group by topic
    by_topic = {}
    for f_item in failed:
        t = f_item['topic']
        if t not in by_topic:
            by_topic[t] = []
        by_topic[t].append(f_item)

    for topic, items in sorted(by_topic.items()):
        print(f"\n  [{topic}]")
        for item in items:
            print(f"    Q{item['id']} ({item['score']}/100): {item['question'][:60]}")
            print(f"      -> {item['detail']}")
