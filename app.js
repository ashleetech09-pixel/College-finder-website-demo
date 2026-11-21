let joinedColleges = [];

const apiKeyInput = document.getElementById('apiKeyInput');
apiKeyInput.value = localStorage.getItem('gemini_api_key') || '';
apiKeyInput.addEventListener('change', () => {
  localStorage.setItem('gemini_api_key', apiKeyInput.value.trim());
});

function parseCSV(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((header, i) => {
      row[header] = values[i] ?? '';
    });
    return row;
  });
}

async function initData() {
  try {
    const [collegesRes, majorsRes, climateRes] = await Promise.all([
      fetch('./data/colleges.csv'),
      fetch('./data/majors.csv'),
      fetch('./data/region_climate.csv')
    ]);

    const collegesRaw = parseCSV(await collegesRes.text());
    const majorsRaw = parseCSV(await majorsRes.text());
    const climateRaw = parseCSV(await climateRes.text());

    const majorsMap = {};
    majorsRaw.forEach((r) => {
      if (!majorsMap[r.college_id]) majorsMap[r.college_id] = [];
      if (r.major) majorsMap[r.college_id].push(r.major);
    });

    const climateMap = {};
    climateRaw.forEach((r) => {
      climateMap[r.state] = r;
    });

    joinedColleges = collegesRaw.map((c) => {
      const climate = climateMap[c.state] || {};
      return {
        ...c,
        enrollment: Number(c.enrollment) || 0,
        majors: majorsMap[c.college_id] || [],
        climate_tag: climate.climate_tag || 'Varied',
        avg_winter_f: climate.avg_winter_f || 'N/A',
        avg_summer_f: climate.avg_summer_f || 'N/A'
      };
    });

    renderCards(joinedColleges, 'All Colleges');
  } catch (err) {
    document.getElementById('resultsGrid').innerHTML =
      '<p>Could not load CSV files. Make sure <code>data/colleges.csv</code>, <code>data/majors.csv</code>, and <code>data/region_climate.csv</code> are committed in your repo.</p>';
  }
}

function localAgentExtract(prompt) {
  const text = prompt.toLowerCase();
  const criteria = { size: null, climate: null, region: null, major: null, explanation: '' };

  if (text.includes('small')) criteria.size = 'Small';
  else if (text.includes('medium') || text.includes('mid-size')) criteria.size = 'Medium';
  else if (text.includes('large') || text.includes('big')) criteria.size = 'Large';

  if (text.includes('warm') || text.includes('hot') || text.includes('sunny')) {
    criteria.climate = ['Warm & Humid', 'Warm & Dry', 'Hot & Sunny'];
  } else if (text.includes('cold') || text.includes('snow') || text.includes('winter') || text.includes('four-season') || text.includes('four seasons')) {
    criteria.climate = ['Cold & Four-Season'];
  }

  for (const r of ['Northeast', 'Southeast', 'Midwest', 'Southwest', 'West']) {
    if (text.includes(r.toLowerCase())) {
      criteria.region = r;
      break;
    }
  }

  const allMajors = [...new Set(joinedColleges.flatMap((c) => c.majors))];
  for (const m of allMajors) {
    if (text.includes(m.toLowerCase())) {
      criteria.major = m;
      break;
    }
  }

  criteria.explanation = 'Evaluated your prompt across size, climate/region, and major tables.';
  return criteria;
}

async function geminiAgentExtract(prompt, apiKey) {
  const availableMajors = [...new Set(joinedColleges.flatMap((c) => c.majors))];
  const availableClimates = [...new Set(joinedColleges.map((c) => c.climate_tag))];

  const systemPrompt = `You are a college search agent. Extract filter criteria from the user's request.
Return ONLY valid JSON with keys:
- "size": "Small" | "Medium" | "Large" | null
- "climate": array of matching strings from ${JSON.stringify(availableClimates)} or null
- "region": "Northeast" | "Southeast" | "Midwest" | "Southwest" | "West" | null
- "major": matching string from ${JSON.stringify(availableMajors)} or null
- "explanation": one short sentence explaining how you filtered the datasets.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\nUser request: ${prompt}` }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    }
  );

  if (!res.ok) throw new Error('Gemini API request failed');
  const data = await res.json();
  const rawText = data.candidates[0].content.parts[0].text;
  return JSON.parse(rawText);
}

function applyFilters(criteria) {
  return joinedColleges.filter((school) => {
    if (criteria.size && school.size !== criteria.size) return false;
    if (criteria.climate && Array.isArray(criteria.climate) && !criteria.climate.includes(school.climate_tag)) return false;
    if (criteria.region && school.region !== criteria.region) return false;
    if (criteria.major && !school.majors.includes(criteria.major)) return false;
    return true;
  });
}

function renderCards(list, heading) {
  document.getElementById('resultsTitle').textContent = heading;
  document.getElementById('resultsCount').textContent = `${list.length} school${list.length === 1 ? '' : 's'}`;

  const grid = document.getElementById('resultsGrid');
  if (list.length === 0) {
    grid.innerHTML = '<p>No colleges matched every filter. Try relaxing one condition (e.g., campus size or climate).</p>';
    return;
  }

  grid.innerHTML = list.map((c) => `
    <article class="college-card">
      <div>
        <h3><a href="${c.url}" target="_blank" rel="noopener">${c.name}</a></h3>
        <div class="location">${c.city}, ${c.state} • ${c.region}</div>
        <div class="stats">
          <div><strong>Size:</strong> ${c.size} (${c.enrollment.toLocaleString()} undergrads)</div>
          <div><strong>Climate:</strong> ${c.climate_tag} (${c.avg_winter_f}°F–${c.avg_summer_f}°F)</div>
        </div>
      </div>
      <div class="tags">
        ${c.majors.map((m) => `<span class="tag">${m}</span>`).join('')}
      </div>
    </article>
  `).join('');
}

async function handleSearch() {
  const query = document.getElementById('userQuery').value.trim();
  if (!query) return;

  const statusBox = document.getElementById('agentReasoning');
  statusBox.classList.remove('hidden');
  statusBox.textContent = 'AI Agent is analyzing your criteria across datasets...';

  const apiKey = apiKeyInput.value.trim();
  let criteria;

  try {
    criteria = apiKey
      ? await geminiAgentExtract(query, apiKey)
      : localAgentExtract(query);
  } catch (e) {
    criteria = localAgentExtract(query);
  }

  const matches = applyFilters(criteria);
  const summaryParts = [];
  if (criteria.major) summaryParts.push(`Major: ${criteria.major}`);
  if (criteria.size) summaryParts.push(`Size: ${criteria.size}`);
  if (criteria.region) summaryParts.push(`Region: ${criteria.region}`);
  if (criteria.climate) summaryParts.push(`Climate: ${criteria.climate.join(' / ')}`);

  statusBox.innerHTML = `<strong>AI Agent Reasoning:</strong> ${criteria.explanation}<br>
    <strong>Active Dataset Filters:</strong> ${summaryParts.length ? summaryParts.join(' • ') : 'None (showing all)'}`;

  renderCards(matches, 'AI Matched Colleges');
}

document.getElementById('searchBtn').addEventListener('click', handleSearch);

document.getElementById('resetBtn').addEventListener('click', () => {
  document.getElementById('userQuery').value = '';
  document.getElementById('agentReasoning').classList.add('hidden');
  renderCards(joinedColleges, 'All Colleges');
});

document.querySelectorAll('.pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('userQuery').value = btn.dataset.prompt;
    handleSearch();
  });
});

initData();
