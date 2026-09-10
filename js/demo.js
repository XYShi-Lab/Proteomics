/* =============================================================================
   demo.js - a synthetic example dataset.

   Values are simulated, but the gene symbols are real human symbols drawn from
   genuine compartments, so GO overlays and pathway enrichment return meaningful
   results on the example the same way they will on your own data. The contrast
   is modelled on an organelle-enrichment experiment: mitochondrial and
   centrosomal proteins go up, ribosomal and nucleolar proteins go down.

   The fold-change column is written as a *signed* fold change (the convention
   most core facilities use) so the example exercises the same parsing path as a
   real vendor report.
   ========================================================================== */
window.VP = window.VP || {};

(function (VP) {
  'use strict';

  const SETS = {
    Mitochondrion: ['TOMM20','TOMM22','TOMM40','TOMM70','TIMM23','TIMM44','TIMM50','MICOS10','MICOS13','IMMT','CHCHD3','CHCHD6','SDHA','SDHB','SDHC','NDUFA4','NDUFA9','NDUFS1','NDUFS3','NDUFV1','UQCRC1','UQCRC2','UQCRFS1','COX4I1','COX5A','COX6C','ATP5F1A','ATP5F1B','ATP5F1C','ATP5MC1','ATP5PB','VDAC1','VDAC2','VDAC3','SLC25A3','SLC25A4','SLC25A5','SLC25A6','SLC25A11','HSPD1','HSPE1','HSPA9','LONP1','CLPP','CLPX','PMPCA','PMPCB','AFG3L2','SPG7','YME1L1','MRPL12','MRPL13','MRPS12','MRPS22','TFAM','POLG','SSBP1','OPA1','MFN1','MFN2','DNM1L','FIS1','MFF','PINK1','PRKN','PHB1','PHB2','CS','ACO2','IDH2','IDH3A','OGDH','SUCLA2','SUCLG1','FH','MDH2','GOT2','GLUD1','HADHA','HADHB','ACADM','ACADVL','CPT1A','CPT2','ETFA','ETFB','ETFDH','PDHA1','PDHB','DLAT','DLD','MRM2','HSD17B8','COQ7','AIFM1','CYCS','BAX','BAK1','GPD2','NNT','SOD2','PRDX3','TXN2','GLRX5','FDX1','NFS1','ISCU','FXN','ABCB7','MTCH2','SAMM50','MTX1','MTX2','DNAJC11','ATAD3A','LETM1','STOML2','TRAP1','HTRA2','OMA1','PARL','SLC25A1','ACSF2','ALDH2','ALDH4A1','AK2','ACAT1','ECHS1','ECI1','MCEE','MUT','PCCA','PCCB','IVD','GCDH','DBT','BCKDHA','SHMT2','MTHFD2','ALDH18A1','PYCR1','OAT','CPS1','OTC'],
    Centrosome: ['CNTROB','CEP135','CEP152','CEP192','CEP250','CEP290','CEP97','PCNT','CETN2','CETN3','SASS6','PLK4','STIL','TUBG1','TUBGCP2','TUBGCP3','NEDD1','ODF2','NIN','AKAP9','CDK5RAP2','CCP110','CEP120','CEP164','CEP170','CEP215','POC1A','POC5','SFI1','ROOT'],
    Lysosome: ['LAMP1','LAMP2','CTSB','CTSD','CTSL','CTSZ','CTSA','GBA1','GLA','HEXA','HEXB','NPC1','NPC2','TPP1','PSAP','GNS','GUSB','MAN2B1','NAGLU','ASAH1','SCARB2','ATP6V1A','ATP6V1B2','ATP6V0D1','ATP6V1E1','MCOLN1','LAMTOR1','LAMTOR2','GRN','SGSH'],
    Ribosome: ['RPL3','RPL4','RPL5','RPL6','RPL7','RPL7A','RPL8','RPL9','RPL10','RPL10A','RPL11','RPL12','RPL13','RPL13A','RPL14','RPL15','RPL17','RPL18','RPL19','RPL21','RPL23','RPL23A','RPL24','RPL26','RPL27','RPL27A','RPL28','RPL30','RPL31','RPL32','RPL34','RPL35','RPL36','RPL37A','RPLP0','RPLP1','RPLP2','RPS2','RPS3','RPS3A','RPS4X','RPS5','RPS6','RPS7','RPS8','RPS9','RPS10','RPS11','RPS12','RPS13','RPS14','RPS15','RPS15A','RPS16','RPS17','RPS18','RPS19','RPS20','RPS23','RPS24','RPS25','RPS26','RPS27','RPS28','RPSA'],
    Nucleolus: ['NPM1','NCL','FBL','NOP56','NOP58','NOP2','RRS1','DDX21','DDX54','XRN2','POLR1A','POLR1B','UBTF','RRP1','RRP9','BOP1','PES1','WDR12','GNL3','MKI67','NOLC1','TCOF1','RPF2','UTP20','WDR43','DKC1','NHP2','GAR1'],
    Spliceosome: ['HNRNPA1','HNRNPA2B1','HNRNPC','HNRNPK','HNRNPM','HNRNPU','SRSF1','SRSF2','SRSF3','SRSF7','SF3B1','SF3B2','SF3A1','SNRPD1','SNRPD2','SNRPD3','SNRPB','SNRNP200','PRPF8','PRPF19','EFTUD2','U2AF1','U2AF2','RBM8A','MAGOH','DDX5','DDX17'],
    'Endoplasmic reticulum': ['CALR','CANX','HSPA5','PDIA3','PDIA4','PDIA6','P4HB','SEC61A1','SEC61B','SEC23A','SEC24C','SEC31A','SRPRA','SRPRB','DDOST','RPN1','RPN2','STT3A','EDEM1','DNAJB11','HYOU1','ERO1A','TMED2','TMED10','ATL3','RTN4','REEP5','VAPA','VAPB','SEL1L','DERL1','VCP','UGGT1','TXNDC5','ERP44'],
    Golgi: ['GOLGA2','GOLGB1','GOLPH3','GOSR2','STX5','TGOLN2','B4GALT1','MAN2A1','MAN1A1','ARF1','ARF4','COPB1','COPB2','COPA','COPG1','ARCN1','COPE','GGA1','GOLIM4','ACBD3'],
    Proteasome: ['PSMA1','PSMA2','PSMA3','PSMA4','PSMA5','PSMA6','PSMA7','PSMB1','PSMB2','PSMB3','PSMB4','PSMB5','PSMB6','PSMB7','PSMC1','PSMC2','PSMC3','PSMC4','PSMC5','PSMC6','PSMD1','PSMD2','PSMD3','PSMD6','PSMD11','PSMD12','PSMD14','PSME1','PSME2','ADRM1'],
    Cytoskeleton: ['ACTB','ACTG1','TUBA1A','TUBA1B','TUBA4A','TUBB','TUBB4B','TUBB6','VIM','MYH9','MYH10','MYL6','MYL12B','TPM1','TPM3','TPM4','CFL1','PFN1','ARPC1B','ARPC2','ARPC3','ARPC5','ACTR2','ACTR3','CAPZA1','CAPZA2','CAPZB','FLNA','FLNB','SPTAN1','SPTBN1','PLEC','KRT8','KRT18','GSN','TLN1','VCL','ZYX','PXN','ACTN1','ACTN4','MYO1C','DSTN','TWF2','CORO1C'],
    Glycolysis: ['GAPDH','ENO1','ENO2','PKM','PGK1','ALDOA','ALDOC','TPI1','PGAM1','LDHA','LDHB','HK1','HK2','PFKP','PFKL','GPI','PYGL','PYGB','G6PD','TALDO1','TKT','PGD','FBP1'],
    Chaperone: ['HSPA8','HSPA1A','HSPA4','HSP90AA1','HSP90AB1','HSP90B1','HSPB1','CCT2','CCT3','CCT4','CCT5','CCT6A','CCT7','CCT8','TCP1','DNAJA1','DNAJA2','DNAJB1','BAG2','BAG3','STIP1','AHSA1','PTGES3','CDC37','ST13'],
    'Vesicle traffic': ['CLTC','CLTA','AP2M1','AP2B1','AP1B1','AP3B1','RAB1A','RAB5C','RAB7A','RAB11A','RAB14','RAB35','SNAP23','STX4','STX7','VAMP3','VAMP7','NSF','NAPA','EEA1','VPS26A','VPS29','VPS35','SNX1','SNX2','SNX6','CHMP4B','TSG101','VPS4A'],
    'Redox & detox': ['SOD1','CAT','GPX1','GPX4','PRDX1','PRDX2','PRDX4','PRDX6','TXN','TXNRD1','GSR','GSTP1','GSTO1','GCLM','NQO1','MGST1','BLVRB','FTH1','FTL','HMOX1'],
    Nucleus: ['LMNA','LMNB1','LMNB2','NUP93','NUP133','NUP205','NUP214','RANBP2','KPNB1','KPNA2','TPR','RAN','XPO1','HIST1H1C','H2AFZ','SMARCA4','SMARCC1','CHD4','HDAC1','HDAC2','RBBP4','SSRP1','SUPT16H','PCNA','RFC1','MCM2','MCM7','TOP2A','TOP1'],
  };

  // Compartments driven by the simulated treatment.
  const EFFECTS = {
    Mitochondrion: 2.5,
    Centrosome: 1.9,
    Lysosome: 0.9,
    Ribosome: -1.7,
    Nucleolus: -1.5,
    Spliceosome: -1.1,
  };

  const DESCRIPTIONS = {
    Mitochondrion: 'mitochondrial protein',
    Centrosome: 'centrosomal protein',
    Lysosome: 'lysosomal protein',
    Ribosome: 'ribosomal protein',
    Nucleolus: 'nucleolar protein',
    Spliceosome: 'spliceosomal protein',
    'Endoplasmic reticulum': 'endoplasmic reticulum protein',
    Golgi: 'Golgi apparatus protein',
    Proteasome: 'proteasome subunit',
    Cytoskeleton: 'cytoskeletal protein',
    Glycolysis: 'glycolytic enzyme',
    Chaperone: 'molecular chaperone',
    'Vesicle traffic': 'vesicle trafficking protein',
    'Redox & detox': 'redox / detoxification enzyme',
    Nucleus: 'nuclear protein',
  };

  /* Deterministic PRNG so the example is identical for everyone. */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rand) {
    // Box-Muller.
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Abramowitz & Stegun 7.1.26 - accurate to ~1.5e-7, which is fine in the body
  // of the distribution but saturates at 1 in the far tail.
  function erf(x) {
    const s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }

  /* Two-sided normal tail. Past |z| = 5 the erf approximation would round to
     exactly 1 and every strong hit would collapse onto the same p-value - a
     flat ceiling of points across the top of the plot. Switch to the asymptotic
     expansion there so the tail keeps resolving. */
  function normalTail(z) {
    const a = Math.abs(z);
    if (a < 5) return 1 - erf(a / Math.SQRT2);
    const inv = 1 / (a * a);
    const series = 1 - inv * (1 - 3 * inv * (1 - 5 * inv));
    return (2 / (a * Math.sqrt(2 * Math.PI))) * Math.exp(-a * a / 2) * series;
  }

  function build() {
    const rand = mulberry32(20260910);
    const rows = [];

    for (const setName in SETS) {
      const effect = EFFECTS[setName] || 0;
      for (const gene of SETS[setName]) {
        // True effect, plus protein-to-protein variation within the compartment.
        const trueL2 = effect === 0
          ? gauss(rand) * 0.28
          : effect + gauss(rand) * (Math.abs(effect) * 0.42 + 0.3);

        // Residual scale. The proportional term matters: in real proteomics the
        // biggest fold changes come from low-abundance, noisy proteins, so the
        // error grows with the effect. That keeps the t-statistic in a plausible
        // range for a 3-vs-3 experiment instead of manufacturing p = 1e-30.
        const se = 0.26 + 0.13 * Math.abs(trueL2) + Math.abs(gauss(rand)) * 0.34;
        const observed = trueL2 + gauss(rand) * se;
        const z = observed / se;
        let p = normalTail(z);
        p = Math.min(0.9999, Math.max(1e-16, p));

        // Written back out as a signed fold change, vendor-report style.
        const signedFc = observed >= 0 ? Math.pow(2, observed) : -Math.pow(2, -observed);
        rows.push({
          gene,
          set: setName,
          desc: DESCRIPTIONS[setName] || 'protein',
          fc: signedFc,
          p,
        });
      }
    }

    // Benjamini-Hochberg, so the adjusted column is internally consistent.
    const adj = VP.stats.benjaminiHochberg(rows.map((r) => r.p));
    rows.forEach((r, i) => { r.padj = adj[i]; });

    const headers = ['Gene', 'Description', 'Compartment',
      'Treated_v_Control_FC', 'Treated_v_Control_pval', 'Treated_v_Control_adjpval'];
    const body = rows.map((r) => [
      r.gene,
      r.desc + ', org=Homo sapiens',
      r.set,
      r.fc.toFixed(4),
      r.p.toExponential(6),
      r.padj.toExponential(6),
    ]);
    return { headers, rows: body, name: 'Example — organelle enrichment (simulated)' };
  }

  let cached = null;
  VP.demo = {
    table() { if (!cached) cached = build(); return cached; },
    SETS,
    toCsv() {
      const t = VP.demo.table();
      return VP.util.toCsv([t.headers].concat(t.rows));
    },
  };
})(window.VP);
