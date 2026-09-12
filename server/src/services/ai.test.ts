import { describe, it, expect } from 'vitest';
import {
  getSystemPromptForCategory,
  getQuantumSystemPrompt,
  getConsultationPrompt,
  getScenarioDeepDivePrompt,
  getStatus,
} from './ai.js';

describe('getStatus', () => {
  it('returns true only for providers whose env variable is set', () => {
    const status = getStatus();
    expect(status).toEqual({
      claude: !!process.env.ANTHROPIC_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
    });
  });
});

describe('getSystemPromptForCategory', () => {
  it('includes the category-specific expertise block', () => {
    const prompt = getSystemPromptForCategory('savunma');
    expect(prompt).toContain('SAVUNMA ANALIZI UZMANI');
    expect(prompt).not.toContain('KUANTUM OLASILIK ANALIZ MOTORU');
  });

  it('falls back to multi-domain expertise for an unknown category', () => {
    const prompt = getSystemPromptForCategory('non-existent-category');
    expect(prompt).toContain('COK ALANLI SENTEZ VE SISTEM DUSUNCESI UZMANI');
  });

  it('uses a social-event skeleton for toplumsal reports instead of the defense skeleton', () => {
    const prompt = getSystemPromptForCategory('toplumsal');
    expect(prompt).toContain('TOPLUMSAL GUVENLIK VE HIBRIT TEHDIT UZMANI');
    expect(prompt).toContain('NEFRET SOYLEMI VE AYRIMCILIK RISKI');
    expect(prompt).toContain('KAMU DUZENI VE GUVENLIK RISKI');
    expect(prompt).not.toContain('NATO / STANAG UYUMU');
    expect(prompt).not.toContain('YERLI TEKNOLOJI ONCELIGI');
  });
});

describe('getQuantumSystemPrompt', () => {
  it('adds the quantum mode instructions', () => {
    const prompt = getQuantumSystemPrompt('ekonomi');
    expect(prompt).toContain('KUANTUM OLASILIK ANALIZ MOTORU');
    expect(prompt).toContain('KUANTUM OLASILIK MATRISI');
    expect(prompt).toContain('STRATEJIK EKONOMI VE MALI ISTIHBARAT UZMANI');
  });
});

describe('getScenarioDeepDivePrompt', () => {
  it('inserts the scenario id and summary into the prompt', () => {
    const prompt = getScenarioDeepDivePrompt('savunma', 'SENARYO-B', 'Test summary');
    expect(prompt).toContain('SENARYO-B');
    expect(prompt).toContain('Test summary');
    expect(prompt).toContain('ALTERNATIF SENARYO DERIN ANALIZI');
  });
});

describe('getConsultationPrompt', () => {
  it('produces general-purpose assistant instructions', () => {
    const prompt = getConsultationPrompt();
    expect(prompt).toContain('BQI Genel Asistanısın');
    expect(prompt).toContain('Zararlı/tehlikeli taleplerde güvenli alternatif öner');
  });
});
