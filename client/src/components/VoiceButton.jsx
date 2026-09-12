import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { useVoice } from '../hooks/useVoice.js';
import { useLang } from '../services/langContext.jsx';

/**
 * mode="input"  — microphone button, converts speech to text (continuous listening by default)
 * mode="output" — speaker button, reads text aloud
 */
export default function VoiceButton({ mode = 'input', text, onTranscript, size = 'md', continuous = true }) {
  const { recording, speaking, startRecording, stopRecording, speak, stopSpeaking } = useVoice();
  const { t } = useLang();

  const sz = size === 'sm' ? 'w-8 h-8' : 'w-10 h-10';
  const ic = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';

  if (mode === 'input') {
    const handleClick = () => {
      if (recording) {
        stopRecording();
      } else {
        startRecording(navigator.language, (transcript) => {
          if (transcript && onTranscript) onTranscript(transcript);
        }, continuous);
      }
    };

    return (
      <div className="relative inline-flex flex-col items-center">
        <motion.button
          onClick={handleClick}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          title={recording ? t('voiceStop') : t('voiceSpeak')}
          className={`${sz} rounded-full flex items-center justify-center transition border-2 ${
            recording
              ? 'bg-red-600 border-red-400'
              : 'bg-navy border-gold/40 hover:border-gold hover:bg-gold/10'
          }`}
          style={recording ? { boxShadow: '0 0 12px rgba(220,38,38,0.6)' } : {}}
        >
          {recording
            ? <MicOff className={`${ic} text-white`} />
            : <Mic className={`${ic} text-gold/70`} />}
        </motion.button>

        <AnimatePresence>
          {recording && (
            <>
              <motion.div
                className="absolute inset-0 rounded-full border-2 border-red-400 pointer-events-none"
                animate={{ scale: [1, 1.5, 1], opacity: [0.7, 0, 0.7] }}
                transition={{ duration: 1.2, repeat: Infinity }}
              />
              <span className="text-xs text-red-400 mt-1 absolute -bottom-5 whitespace-nowrap">
                {t('voiceListening')}
              </span>
            </>
          )}
        </AnimatePresence>
      </div>
    );
  }

  if (mode === 'output') {
    return (
      <motion.button
        onClick={() => speaking ? stopSpeaking() : text && speak(text, navigator.language)}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        title={speaking ? t('voiceStop') : t('voiceReadAloud')}
        className={`${sz} rounded-full flex items-center justify-center transition border border-gold/30 hover:border-gold hover:bg-gold/10`}
      >
        {speaking
          ? <VolumeX className={`${ic} text-gold`} />
          : <Volume2 className={`${ic} text-gold/70`} />}
      </motion.button>
    );
  }

  return null;
}
