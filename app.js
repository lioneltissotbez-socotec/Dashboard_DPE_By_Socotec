// Configuration
const API_BASE_URL = 'https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines';
const RATE_LIMIT_DELAY = 100; // ms entre requêtes
const MAX_RESULTS_PER_QUERY = 1000;

// Variables globales
let dpeData = [];
let map = null;
let charts = {};
let dataTable = null;

// Couleurs étiquettes DPE
const DPE_COLORS = {
    'A': '#00A05B',
    'B': '#5DAE49',
    'C': '#C4D12F',
    'D': '#FDEE00',
    'E': '#FCBA03',
    'F': '#F18B00',
    'G': '#ED1C24'
};

// Initialisation
document.addEventListener('DOMContentLoaded', function() {
    initEventListeners();
});

function initEventListeners() {
    document.getElementById('analyseBtn').addEventListener('click', analyserPatrimoine);
    document.getElementById('exempleBtn').addEventListener('click', chargerExemple);
    document.getElementById('exportExcelBtn').addEventListener('click', exporterExcel);
    document.getElementById('exportPdfBtn').addEventListener('click', exporterPDF);
}

function chargerExemple() {
    document.getElementById('clientId').value = 'BAILLEUR_DEMO_001';
    document.getElementById('clientNameInput').value = 'Habitat Social Paris Centre';
    document.getElementById('adressesList').value = `12 rue Victor Hugo 75001 Paris
45 avenue Foch 75008 Paris
8 boulevard Haussmann 75009 Paris
23 rue de Rivoli 75004 Paris
67 avenue des Champs-Élysées 75008 Paris`;
}

async function analyserPatrimoine() {
    const clientId = document.getElementById('clientId').value.trim();
    const clientName = document.getElementById('clientNameInput').value.trim();
    const adressesText = document.getElementById('adressesList').value.trim();

    if (!clientId || !clientName || !adressesText) {
        showMessage('Veuillez remplir tous les champs', 'danger');
        return;
    }

    // Parser les adresses
    const adresses = parseAdresses(adressesText);
    
    if (adresses.length === 0) {
        showMessage('Aucune adresse valide détectée', 'danger');
        return;
    }

    // Afficher le nom du client
    document.getElementById('clientName').textContent = clientName;

    // Afficher la progression
    showProgress(true);
    showMessage(`Analyse de ${adresses.length} adresse(s) en cours...`, 'info');

    try {
        // Récupérer les DPE
        dpeData = await recupererDPE(adresses);

        if (dpeData.length === 0) {
            showMessage('Aucun DPE trouvé pour les adresses fournies', 'warning');
            showProgress(false);
            return;
        }

        showMessage(`${dpeData.length} DPE trouvé(s) sur ${adresses.length} adresse(s)`, 'success');
        
        // Afficher les résultats
        afficherResultats();
        
    } catch (error) {
        console.error('Erreur:', error);
        showMessage('Erreur lors de l\'analyse : ' + error.message, 'danger');
    } finally {
        showProgress(false);
    }
}

function parseAdresses(text) {
    const lines = text.split('\n').filter(line => line.trim() !== '');
    const adresses = [];

    for (let line of lines) {
        // Détecter si format tabulaire (séparé par tabulation ou |)
        if (line.includes('\t') || line.includes('|')) {
            const parts = line.split(/[\t|]/).map(p => p.trim());
            // Format: adresse | code postal | ville
            if (parts.length >= 2) {
                adresses.push({
                    adresse_complete: parts.join(' '),
                    adresse: parts[0],
                    code_postal: parts[1],
                    ville: parts[2] || ''
                });
            }
        } else {
            // Format libre
            adresses.push({
                adresse_complete: line.trim(),
                adresse: line.trim(),
                code_postal: extraireCodePostal(line),
                ville: ''
            });
        }
    }

    return adresses;
}

function extraireCodePostal(text) {
    const match = text.match(/\b\d{5}\b/);
    return match ? match[0] : '';
}

async function recupererDPE(adresses) {
    let allDPE = [];
    let compteur = 0;

    for (let addr of adresses) {
        compteur++;
        updateProgress((compteur / adresses.length) * 100);

        try {
            // Stratégie multi-requêtes pour maximiser les résultats
            let queries = [];

            // Query 1: Par code postal et partie de l'adresse
            if (addr.code_postal) {
                const adresseSimplifiee = simplifierAdresse(addr.adresse);
                queries.push(`qs=Code_postal_ban:${addr.code_postal} AND Adresse_brut:*${encodeURIComponent(adresseSimplifiee)}*`);
            }

            // Query 2: Recherche texte libre
            queries.push(`q=${encodeURIComponent(addr.adresse_complete)}&q_fields=Adresse_brut`);

            for (let query of queries) {
                const url = `${API_BASE_URL}?${query}&size=${MAX_RESULTS_PER_QUERY}&select=N°_DPE,Adresse_brut,Code_postal_ban,Nom_commune_brut,Etiquette_DPE,Etiquette_GES,Surface_habitable_logement,Conso_5_usages_m2,Emission_GES_5_usages_m2,Coût_total_5_usages,Type_bâtiment,Type_énergie_principale_chauffage,Date_établissement_DPE,Coordonnée_cartographique_X,Coordonnée_cartographique_Y,Période_construction,Coût_chauffage,Coût_ECS,Coût_éclairage`;

                const response = await fetch(url);
                
                if (!response.ok) {
                    console.warn(`Erreur API pour ${addr.adresse_complete}: ${response.status}`);
                    continue;
                }

                const data = await response.json();
                
                if (data.results && data.results.length > 0) {
                    allDPE.push(...data.results);
                    break; // Si on a des résultats, pas besoin d'essayer les autres queries
                }

                // Respect du rate limit
                await sleep(RATE_LIMIT_DELAY);
            }

        } catch (error) {
            console.error(`Erreur pour ${addr.adresse_complete}:`, error);
        }
    }

    // Dédoublonner par N°_DPE
    const unique = {};
    allDPE.forEach(dpe => {
        if (dpe['N°_DPE'] && !unique[dpe['N°_DPE']]) {
            unique[dpe['N°_DPE']] = dpe;
        }
    });

    return Object.values(unique);
}

function simplifierAdresse(adresse) {
    // Retirer les numéros et caractères spéciaux, garder les mots principaux
    return adresse
        .replace(/^\d+\s*/, '') // Retirer numéro de rue
        .replace(/[^\w\s]/g, ' ') // Retirer ponctuation
        .split(' ')
        .filter(word => word.length > 3) // Garder mots > 3 lettres
        .slice(0, 2) // Prendre les 2 premiers mots
        .join(' ');
}

function afficherResultats() {
    document.getElementById('resultsSection').style.display = 'block';

    // KPIs
    afficherKPIs();

    // Graphiques
    afficherGraphiques();

    // Carte
    afficherCarte();

    // Tableau
    afficherTableau();

    // Alertes DPE
    afficherAlertesDPE();
}

function afficherKPIs() {
    const nbLogements = dpeData.length;
    const surfaceTotale = dpeData.reduce((sum, dpe) => 
        sum + (parseFloat(dpe.Surface_habitable_logement) || 0), 0);
    
    const consos = dpeData
        .map(dpe => parseFloat(dpe.Conso_5_usages_m2))
        .filter(c => !isNaN(c));
    const consoMoyenne = consos.length > 0 
        ? consos.reduce((a, b) => a + b, 0) / consos.length 
        : 0;

    const couts = dpeData
        .map(dpe => parseFloat(dpe['Coût_total_5_usages']))
        .filter(c => !isNaN(c));
    const coutTotal = couts.reduce((a, b) => a + b, 0);

    document.getElementById('kpiLogements').textContent = nbLogements;
    document.getElementById('kpiSurface').textContent = Math.round(surfaceTotale).toLocaleString();
    document.getElementById('kpiConso').textContent = Math.round(consoMoyenne);
    document.getElementById('kpiCout').textContent = Math.round(coutTotal).toLocaleString();
}

function afficherGraphiques() {
    // Graphique étiquettes DPE
    const repartitionEtiquettes = compterEtiquettes(dpeData);
    
    if (charts.etiquettes) charts.etiquettes.destroy();
    
    charts.etiquettes = new Chart(document.getElementById('chartEtiquettes'), {
        type: 'pie',
        data: {
            labels: Object.keys(repartitionEtiquettes),
            datasets: [{
                data: Object.values(repartitionEtiquettes),
                backgroundColor: Object.keys(repartitionEtiquettes).map(e => DPE_COLORS[e])
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'right' },
                title: { display: false }
            }
        }
    });

    // Graphique par type de bien
    const parType = {};
    dpeData.forEach(dpe => {
        const type = dpe['Type_bâtiment'] || 'Non renseigné';
        if (!parType[type]) parType[type] = { count: 0, consoTotal: 0 };
        parType[type].count++;
        parType[type].consoTotal += parseFloat(dpe.Conso_5_usages_m2) || 0;
    });

    const typesLabels = Object.keys(parType);
    const typesConso = typesLabels.map(t => 
        parType[t].count > 0 ? parType[t].consoTotal / parType[t].count : 0
    );

    if (charts.typeBien) charts.typeBien.destroy();

    charts.typeBien = new Chart(document.getElementById('chartTypeBien'), {
        type: 'bar',
        data: {
            labels: typesLabels,
            datasets: [{
                label: 'Consommation moyenne (kWh/m²/an)',
                data: typesConso,
                backgroundColor: '#0d6efd'
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true }
            }
        }
    });

    // Graphique énergies
    const energies = {};
    dpeData.forEach(dpe => {
        const energie = dpe['Type_énergie_principale_chauffage'] || 'Non renseigné';
        energies[energie] = (energies[energie] || 0) + 1;
    });

    if (charts.energies) charts.energies.destroy();

    charts.energies = new Chart(document.getElementById('chartEnergies'), {
        type: 'doughnut',
        data: {
            labels: Object.keys(energies),
            datasets: [{
                data: Object.values(energies),
                backgroundColor: ['#0d6efd', '#198754', '#ffc107', '#dc3545', '#6c757d']
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'right' }
            }
        }
    });

    // Graphique expiration
    const expiration = calculerExpiration(dpeData);

    if (charts.expiration) charts.expiration.destroy();

    charts.expiration = new Chart(document.getElementById('chartExpiration'), {
        type: 'bar',
        data: {
            labels: ['< 6 mois', '6-12 mois', '1-2 ans', '> 2 ans'],
            datasets: [{
                label: 'Nombre de DPE',
                data: [
                    expiration.moins6mois,
                    expiration.entre6et12,
                    expiration.entre1et2ans,
                    expiration.plus2ans
                ],
                backgroundColor: ['#dc3545', '#ffc107', '#0dcaf0', '#198754']
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true }
            }
        }
    });
}

function compterEtiquettes(data) {
    const etiquettes = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
    data.forEach(dpe => {
        const etiquette = dpe.Etiquette_DPE;
        if (etiquettes.hasOwnProperty(etiquette)) {
            etiquettes[etiquette]++;
        }
    });
    return etiquettes;
}

function calculerExpiration(data) {
    const now = new Date();
    const result = {
        moins6mois: 0,
        entre6et12: 0,
        entre1et2ans: 0,
        plus2ans: 0
    };

    data.forEach(dpe => {
        const dateEtab = new Date(dpe['Date_établissement_DPE']);
        const expiration = new Date(dateEtab);
        expiration.setFullYear(expiration.getFullYear() + 10);

        const moisRestants = (expiration - now) / (1000 * 60 * 60 * 24 * 30);

        if (moisRestants < 6) result.moins6mois++;
        else if (moisRestants < 12) result.entre6et12++;
        else if (moisRestants < 24) result.entre1et2ans++;
        else result.plus2ans++;
    });

    return result;
}

function afficherAlertesDPE() {
    const now = new Date();
    const alertes = [];

    dpeData.forEach(dpe => {
        const dateEtab = new Date(dpe['Date_établissement_DPE']);
        const expiration = new Date(dateEtab);
        expiration.setFullYear(expiration.getFullYear() + 10);

        const moisRestants = (expiration - now) / (1000 * 60 * 60 * 24 * 30);

        if (moisRestants < 12) {
            alertes.push({
                adresse: dpe.Adresse_brut,
                mois: Math.floor(moisRestants),
                date: expiration.toLocaleDateString('fr-FR')
            });
        }
    });

    const container = document.getElementById('alertesDPE');
    
    if (alertes.length === 0) {
        container.innerHTML = '<div class="alert alert-success">Aucun DPE à renouveler dans les 12 prochains mois</div>';
    } else {
        let html = `<div class="alert alert-warning"><strong>⚠️ ${alertes.length} DPE à renouveler prochainement :</strong><ul class="mt-2 mb-0">`;
        alertes.slice(0, 5).forEach(a => {
            html += `<li>${a.adresse} - expire dans ${a.mois} mois (${a.date})</li>`;
        });
        if (alertes.length > 5) {
            html += `<li><em>... et ${alertes.length - 5} autre(s)</em></li>`;
        }
        html += '</ul></div>';
        container.innerHTML = html;
    }
}

function afficherCarte() {
    if (map) {
        map.remove();
    }

    map = L.map('map').setView([48.8566, 2.3522], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const bounds = [];

    dpeData.forEach(dpe => {
        const x = parseFloat(dpe.Coordonnée_cartographique_X);
        const y = parseFloat(dpe.Coordonnée_cartographique_Y);

        if (!isNaN(x) && !isNaN(y)) {
            // Conversion Lambert 93 vers WGS84 (approximation)
            const [lat, lng] = lambert93ToWGS84(x, y);

            if (lat && lng) {
                const etiquette = dpe.Etiquette_DPE || 'N/A';
                const color = DPE_COLORS[etiquette] || '#999';

                const marker = L.circleMarker([lat, lng], {
                    radius: 8,
                    fillColor: color,
                    color: '#fff',
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 0.8
                }).addTo(map);

                marker.bindPopup(`
                    <strong>${dpe.Adresse_brut}</strong><br>
                    DPE: <span style="color:${color}; font-weight:bold;">${etiquette}</span><br>
                    ${dpe.Surface_habitable_logement} m²<br>
                    ${Math.round(dpe.Conso_5_usages_m2)} kWh/m²/an
                `);

                bounds.push([lat, lng]);
            }
        }
    });

    if (bounds.length > 0) {
        map.fitBounds(bounds);
    }
}

function lambert93ToWGS84(x, y) {
    // Conversion approximative Lambert 93 -> WGS84
    // Pour une conversion précise, utiliser une bibliothèque comme proj4js
    const lat = 48.8566 + (y - 6800000) / 111320;
    const lng = 2.3522 + (x - 655000) / (111320 * Math.cos(lat * Math.PI / 180));
    
    if (Math.abs(lat - 48.8566) > 10 || Math.abs(lng - 2.3522) > 10) {
        return [null, null]; // Coordonnées aberrantes
    }
    
    return [lat, lng];
}

function afficherTableau() {
    const tbody = document.getElementById('tableauBody');
    tbody.innerHTML = '';

    dpeData.forEach(dpe => {
        const dateEtab = new Date(dpe['Date_établissement_DPE']);
        const expiration = new Date(dateEtab);
        expiration.setFullYear(expiration.getFullYear() + 10);

        const row = tbody.insertRow();
        row.innerHTML = `
            <td>${dpe.Adresse_brut || 'N/A'}</td>
            <td>${dpe.Code_postal_ban || 'N/A'}</td>
            <td><span class="badge" style="background-color:${DPE_COLORS[dpe.Etiquette_DPE] || '#999'}">${dpe.Etiquette_DPE || 'N/A'}</span></td>
            <td><span class="badge" style="background-color:${DPE_COLORS[dpe.Etiquette_GES] || '#999'}">${dpe.Etiquette_GES || 'N/A'}</span></td>
            <td>${Math.round(dpe.Surface_habitable_logement || 0)}</td>
            <td>${Math.round(dpe.Conso_5_usages_m2 || 0)}</td>
            <td>${Math.round(dpe['Coût_total_5_usages'] || 0)}</td>
            <td>${dpe['Type_énergie_principale_chauffage'] || 'N/A'}</td>
            <td>${dateEtab.toLocaleDateString('fr-FR')}</td>
            <td>${expiration.toLocaleDateString('fr-FR')}</td>
        `;
    });

    // Initialiser DataTables
    if (dataTable) {
        dataTable.destroy();
    }

    dataTable = $('#tableauLogements').DataTable({
        language: {
            url: '//cdn.datatables.net/plug-ins/1.13.6/i18n/fr-FR.json'
        },
        pageLength: 25,
        order: [[8, 'desc']] // Trier par date
    });
}

function exporterExcel() {
    const ws_data = [
        ['Adresse', 'Code Postal', 'Étiquette DPE', 'Étiquette GES', 'Surface (m²)', 
         'Conso (kWh/m²/an)', 'Coût annuel (€)', 'Énergie chauffage', 'Date DPE', 'N° DPE']
    ];

    dpeData.forEach(dpe => {
        ws_data.push([
            dpe.Adresse_brut || '',
            dpe.Code_postal_ban || '',
            dpe.Etiquette_DPE || '',
            dpe.Etiquette_GES || '',
            dpe.Surface_habitable_logement || '',
            dpe.Conso_5_usages_m2 || '',
            dpe['Coût_total_5_usages'] || '',
            dpe['Type_énergie_principale_chauffage'] || '',
            dpe['Date_établissement_DPE'] || '',
            dpe['N°_DPE'] || ''
        ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(ws_data);
    XLSX.utils.book_append_sheet(wb, ws, "DPE Patrimoine");

    const clientName = document.getElementById('clientNameInput').value.trim();
    const filename = `DPE_${clientName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
    
    XLSX.writeFile(wb, filename);
}

function exporterPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    const clientName = document.getElementById('clientNameInput').value.trim();
    
    doc.setFontSize(18);
    doc.text(`Rapport DPE Patrimoine`, 14, 20);
    doc.setFontSize(12);
    doc.text(`Client: ${clientName}`, 14, 30);
    doc.text(`Date: ${new Date().toLocaleDateString('fr-FR')}`, 14, 37);

    doc.setFontSize(14);
    doc.text('Indicateurs clés', 14, 50);
    doc.setFontSize(10);
    doc.text(`Logements analysés: ${dpeData.length}`, 14, 58);
    
    const surfaceTotale = dpeData.reduce((sum, dpe) => 
        sum + (parseFloat(dpe.Surface_habitable_logement) || 0), 0);
    doc.text(`Surface totale: ${Math.round(surfaceTotale)} m²`, 14, 65);

    const filename = `Rapport_DPE_${clientName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
    doc.save(filename);
}

// Fonctions utilitaires
function showProgress(show) {
    document.getElementById('progressBar').style.display = show ? 'block' : 'none';
}

function updateProgress(percent) {
    const bar = document.querySelector('.progress-bar');
    bar.style.width = `${percent}%`;
}

function showMessage(message, type) {
    const msgDiv = document.getElementById('statusMessage');
    msgDiv.className = `alert alert-${type}`;
    msgDiv.textContent = message;
    msgDiv.style.display = 'block';

    if (type === 'success') {
        setTimeout(() => {
            msgDiv.style.display = 'none';
        }, 5000);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
