
import React, { useState, useEffect, useRef } from 'react';
import { ShaderError, VideoConfig, ShotType } from '../types';
import Editor, { useMonaco } from '@monaco-editor/react';

// --- Types ---
export interface MenuItem {
    label: string;
    action: () => void;
    shortcut?: string;
}

export interface MenuGroup {
    label: string;
    items: MenuItem[];
}

// --- Components ---

interface ErrorDisplayProps {
  error: ShaderError | null;
  onClose: () => void;
}

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({ error, onClose }) => {
  const [copied, setCopied] = useState(false);
  if (!error) return null;

  const handleCopy = () => {
    const text = `SYSTEM DIAGNOSTIC REPORT\n------------------------\nTYPE: ${error.type.toUpperCase()}\nMESSAGE:\n${error.message}\n${error.lineNum ? `LINE: ${error.lineNum}\nPOS: ${error.linePos}` : ''}\nTIMESTAMP: ${new Date().toISOString()}`;
    navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    });
  };

  const isValidation = error.message.includes("Validation") || error.message.includes("Pipeline");

  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-8 animate-fade-in-up">
      <div className="w-full max-w-4xl bg-black border border-red-600 shadow-[0_0_100px_rgba(220,38,38,0.4)] relative flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-red-900/50 bg-red-950/20">
             <div className="flex items-center gap-4">
                 <div className="w-3 h-3 bg-red-600 animate-pulse"></div>
                 <div>
                     <h2 className="text-2xl font-bold text-red-500 tracking-tighter uppercase">
                         {isValidation ? "GPU Validation Failure" : "System Error"}
                     </h2>
                     <p className="font-mono text-[10px] text-red-500/60 uppercase tracking-[0.2em]">Diagnostic Trace Active</p>
                 </div>
             </div>
             <button onClick={onClose} className="p-2 hover:bg-red-900/40 text-red-500 transition-colors">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M6 18L18 6M6 6l12 12" /></svg>
             </button>
        </div>

        {/* Content */}
        <div className="p-8 overflow-y-auto custom-scrollbar bg-black/50">
             <div className="grid grid-cols-1 gap-8">
                 {/* Main Error */}
                 <div className="space-y-2">
                     <label className="text-[10px] font-mono text-red-700 uppercase tracking-widest">Stack Trace</label>
                     <div className="p-6 bg-red-950/10 border border-red-900/30 text-red-400 font-mono text-sm whitespace-pre-wrap leading-relaxed shadow-inner">
                         {error.message}
                     </div>
                 </div>

                 {/* Diagnostics / Context */}
                 <div className="grid grid-cols-2 gap-8">
                     <div className="space-y-2">
                         <label className="text-[10px] font-mono text-gray-600 uppercase tracking-widest">Location</label>
                         <div className="p-4 bg-white/5 border border-white/10 text-gray-300 font-mono text-xs">
                             {error.lineNum ? (
                                 <>
                                     <div className="flex justify-between"><span>LINE_NUMBER</span> <span className="text-white">{error.lineNum}</span></div>
                                     <div className="flex justify-between"><span>COLUMN_POS</span> <span className="text-white">{error.linePos}</span></div>
                                 </>
                             ) : (
                                 <div className="text-gray-600 italic">
                                     {isValidation 
                                        ? "Error occurred during command encoding or pipeline state validation. The shader syntax is likely valid, but the data layout or resource binding is incorrect."
                                        : "No line info available."}
                                 </div>
                             )}
                         </div>
                     </div>
                     
                     <div className="space-y-2">
                        <label className="text-[10px] font-mono text-gray-600 uppercase tracking-widest">Troubleshooting</label>
                        <ul className="list-disc pl-4 text-xs font-mono text-gray-400 space-y-1">
                            {error.message.includes("Invalid CommandBuffer") && <li>Command encoding failed due to a previous error.</li>}
                            {error.message.includes("buffer size") && <li>Buffer size mismatch. Uniform struct > 512 bytes?</li>}
                            {error.message.includes("TextureView") && <li>Resizing canvas to 0x0?</li>}
                            {error.message.includes("layout") && <li>WGSL struct padding doesn't match JS Float32Array.</li>}
                            {error.message.includes("Pipeline") && <li>Shader inputs/outputs don't match pipeline definition.</li>}
                        </ul>
                     </div>
                 </div>
             </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-red-900/50 bg-red-950/20 flex justify-between items-center">
            <span className="text-[10px] font-mono text-red-800">ERR_ID: {Math.floor(Math.random() * 0xFFFFFF).toString(16).toUpperCase()}</span>
            <div className="flex gap-2">
                <button onClick={() => window.location.reload()} className="px-4 py-2 text-xs font-mono font-bold uppercase tracking-widest bg-red-900/20 text-red-500 hover:bg-red-900/40">
                    Reload App
                </button>
                <button 
                    onClick={handleCopy} 
                    className={`px-6 py-2 text-xs font-mono font-bold uppercase tracking-widest transition-all ${copied ? 'bg-green-600 text-white' : 'bg-white/10 text-white hover:bg-white/20'}`}
                >
                    {copied ? 'Copied' : 'Copy Trace'}
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};

export const DocumentationOverlay: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xl flex justify-end">
      <div className="w-full max-w-2xl bg-void h-full border-l border-white/10 p-12 overflow-y-auto animate-slide-in-right custom-scrollbar relative">
         <button onClick={onClose} className="absolute top-8 right-8 text-white/50 hover:text-white transition-colors">
             <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M6 18L18 6M6 6l12 12" /></svg>
         </button>
         
         <div className="space-y-12">
             <div>
                 <h1 className="text-5xl font-bold tracking-tighter mb-4 text-white">Documentation</h1>
                 <p className="font-mono text-sm text-gray-400">WebGPU Render Engine v2.0</p>
             </div>
             
             <div className="space-y-6">
                 <h3 className="text-xl font-bold text-acid uppercase tracking-widest border-b border-white/10 pb-2">Uniform Buffer</h3>
                 <p className="text-gray-400 leading-relaxed">
                     The engine automatically binds the following uniforms to <code className="text-white bg-white/10 px-1">group(0) binding(0)</code>:
                 </p>
                 <ul className="grid grid-cols-1 gap-2 font-mono text-xs text-gray-300">
                     <li className="bg-white/5 p-3 flex justify-between"><span>resolution</span> <span className="text-gray-500">vec2f</span></li>
                     <li className="bg-white/5 p-3 flex justify-between"><span>time</span> <span className="text-gray-500">f32</span></li>
                     <li className="bg-white/5 p-3 flex justify-between"><span>cameraPos</span> <span className="text-gray-500">vec4f</span></li>
                     <li className="bg-white/5 p-3 flex justify-between"><span>mouse</span> <span className="text-gray-500">vec4f (x, y, click, scroll)</span></li>
                     <li className="bg-white/5 p-3 flex justify-between"><span>params...</span> <span className="text-gray-500">float/vec3</span></li>
                 </ul>
             </div>

             <div className="space-y-6">
                 <h3 className="text-xl font-bold text-acid uppercase tracking-widest border-b border-white/10 pb-2">Troubleshooting</h3>
                 <div className="space-y-4 text-sm text-gray-400">
                     <p><strong className="text-white">Device Lost:</strong> This usually happens if the shader takes too long to execute (TDR). Try reducing loop iterations in `raymarch` or `getGlow`.</p>
                     <p><strong className="text-white">Syntax Error:</strong> The shader compiler is strict. Ensure all vector types match (e.g. `vec3f` vs `vec3`). Check the error overlay for line numbers.</p>
                 </div>
             </div>
         </div>
      </div>
    </div>
  );
};

export const MenuBar: React.FC<{ menus: MenuGroup[] }> = ({ menus }) => {
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    return (
        <div className="absolute top-0 left-0 w-full h-10 bg-black/80 backdrop-blur-md border-b border-white/10 flex items-center px-4 z-40 select-none">
            <div className="font-bold tracking-tighter mr-8 text-white">RENDER_LAB</div>
            <div className="flex h-full">
                {menus.map((menu, i) => (
                    <div key={i} className="relative h-full" onMouseEnter={() => openIndex !== null && setOpenIndex(i)}>
                        <button 
                            className={`h-full px-4 text-xs font-mono uppercase tracking-wider hover:bg-white/10 transition-colors ${openIndex === i ? 'bg-white/10 text-white' : 'text-gray-400'}`}
                            onClick={() => setOpenIndex(openIndex === i ? null : i)}
                        >
                            {menu.label}
                        </button>
                        {openIndex === i && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setOpenIndex(null)} />
                                <div className="absolute top-full left-0 w-64 bg-black border border-white/10 shadow-2xl z-50 py-2">
                                    {menu.items.map((item, j) => (
                                        <button 
                                            key={j}
                                            className="w-full text-left px-6 py-2 text-xs font-mono text-gray-300 hover:bg-acid hover:text-black transition-colors flex justify-between group"
                                            onClick={() => { item.action(); setOpenIndex(null); }}
                                        >
                                            <span>{item.label}</span>
                                            {item.shortcut && <span className="opacity-30 group-hover:opacity-100">{item.shortcut}</span>}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};

interface VideoExportProps {
    isOpen: boolean;
    onClose: () => void;
    onStartRecord: (config: VideoConfig) => void;
}

export const VideoExportOverlay: React.FC<VideoExportProps> = ({ isOpen, onClose, onStartRecord }) => {
    const [config, setConfig] = useState<VideoConfig>({
        duration: 5,
        fps: 60,
        bitrate: 12,
        shotType: 'orbit',
        orchestrate: false,
        postProcess: { grain: 0.05, aberration: 0.05 },
        format: 'webm'
    });

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
            <div className="w-[500px] bg-void border border-white/10 p-8 shadow-2xl animate-fade-in-up">
                <h2 className="text-2xl font-bold mb-6 tracking-tighter">Render Sequence</h2>
                
                <div className="space-y-6 mb-8">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-[10px] font-mono uppercase tracking-widest text-gray-500 mb-2">Duration (Sec)</label>
                            <input type="number" value={config.duration} onChange={e => setConfig({...config, duration: Number(e.target.value)})} className="w-full bg-white/5 border border-white/10 p-2 text-sm font-mono focus:border-acid outline-none transition-colors" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-mono uppercase tracking-widest text-gray-500 mb-2">Framerate</label>
                            <select value={config.fps} onChange={e => setConfig({...config, fps: Number(e.target.value)})} className="w-full bg-white/5 border border-white/10 p-2 text-sm font-mono focus:border-acid outline-none transition-colors appearance-none">
                                <option value="30">30 FPS</option>
                                <option value="60">60 FPS</option>
                            </select>
                        </div>
                    </div>
                    
                    <div>
                        <label className="block text-[10px] font-mono uppercase tracking-widest text-gray-500 mb-2">Camera Movement</label>
                        <div className="grid grid-cols-3 gap-2">
                            {(['orbit', 'sweep', 'dolly', 'breathing', 'chaos'] as ShotType[]).map(type => (
                                <button
                                    key={type}
                                    onClick={() => setConfig({...config, shotType: type})}
                                    className={`p-2 text-[10px] font-mono uppercase border transition-all ${config.shotType === type ? 'border-acid text-acid bg-acid/10' : 'border-white/10 text-gray-500 hover:border-white/30'}`}
                                >
                                    {type}
                                </button>
                            ))}
                        </div>
                    </div>

                    <label className="flex items-center gap-3 cursor-pointer group">
                        <div className={`w-4 h-4 border transition-colors ${config.orchestrate ? 'bg-acid border-acid' : 'border-white/30 group-hover:border-white'}`}></div>
                        <span className="text-xs font-mono text-gray-400 group-hover:text-white transition-colors">Auto-Orchestrate Parameters</span>
                        <input type="checkbox" className="hidden" checked={config.orchestrate} onChange={e => setConfig({...config, orchestrate: e.target.checked})} />
                    </label>
                </div>

                <div className="flex gap-3">
                    <button onClick={onClose} className="flex-1 py-3 text-xs font-mono uppercase tracking-widest border border-white/10 hover:bg-white/5 transition-colors">Cancel</button>
                    <button onClick={() => { onStartRecord(config); onClose(); }} className="flex-1 py-3 text-xs font-mono uppercase tracking-widest bg-acid text-black font-bold hover:bg-white transition-colors">Start Render</button>
                </div>
            </div>
        </div>
    );
};

export const RecordingIndicator: React.FC<{ isRecording: boolean; timeLeft: number; onStop: () => void }> = ({ isRecording, timeLeft, onStop }) => {
    if (!isRecording) return null;
    return (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-red-600 text-white px-6 py-2 rounded-full font-mono text-sm flex items-center gap-4 z-50 animate-pulse-fast shadow-[0_0_30px_rgba(220,38,38,0.5)]">
            <div className="w-2 h-2 bg-white rounded-full"></div>
            <span>REC // {timeLeft.toFixed(1)}s</span>
            <button onClick={onStop} className="hover:underline opacity-80 hover:opacity-100 border-l border-white/30 pl-4">STOP</button>
        </div>
    );
};

interface ShaderEditorProps {
    isOpen: boolean;
    onClose: () => void;
    code: string;
    onCodeChange: (code: string) => void;
    error: ShaderError | null;
}

export const ShaderEditor: React.FC<ShaderEditorProps> = ({ isOpen, onClose, code, onCodeChange, error }) => {
    const monaco = useMonaco();
    
    // Add custom keywords to Monaco
    useEffect(() => {
        if (monaco) {
            monaco.languages.register({ id: 'wgsl' });
            monaco.languages.setMonarchTokensProvider('wgsl', {
                tokenizer: {
                    root: [
                        [/\b(fn|let|var|if|else|for|return|struct|type)\b/, 'keyword'],
                        [/\b(vec2f|vec3f|vec4f|f32|i32|u32|mat4x4f)\b/, 'type'],
                        [/\b(normalize|dot|cross|mix|clamp|pow|sin|cos|length|max|min|abs|fract|floor)\b/, 'function'],
                        [/\d+(\.\d+)?/, 'number'],
                        [/\/\/.*$/, 'comment']
                    ]
                }
            });
            monaco.editor.defineTheme('wgsl-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [
                    { token: 'keyword', foreground: 'ccff00' },
                    { token: 'type', foreground: '569cd6' },
                    { token: 'function', foreground: 'dcdcaa' },
                    { token: 'comment', foreground: '6a9955' },
                ],
                colors: {
                    'editor.background': '#0a0a0a',
                }
            });
        }
    }, [monaco]);

    return (
        <div className={`fixed inset-y-0 left-0 w-[600px] bg-[#0a0a0a] border-r border-white/10 transform transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] z-30 flex flex-col ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            <div className="h-10 bg-black border-b border-white/10 flex items-center justify-between px-4">
                 <span className="text-xs font-mono text-gray-400">SHADER_SOURCE.WGSL</span>
                 <button onClick={onClose} className="text-gray-500 hover:text-white">
                     <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                 </button>
            </div>
            <div className="flex-1 relative">
                <Editor 
                    height="100%"
                    language="wgsl"
                    theme="wgsl-dark"
                    value={code}
                    onChange={(val) => val && onCodeChange(val)}
                    options={{
                        minimap: { enabled: false },
                        fontSize: 12,
                        fontFamily: "'JetBrains Mono', monospace",
                        padding: { top: 20 },
                        scrollBeyondLastLine: false,
                        smoothScrolling: true,
                        cursorBlinking: 'smooth',
                        cursorSmoothCaretAnimation: 'on'
                    }}
                />
            </div>
            {error && (
                <div className="p-4 bg-red-900/20 border-t border-red-900/50 text-red-400 text-xs font-mono">
                    ERROR: {error.message} (Line {error.lineNum})
                </div>
            )}
        </div>
    );
};
