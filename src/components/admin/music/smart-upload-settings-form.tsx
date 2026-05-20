'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronDown,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Wifi,
  FileText,
  Zap,
  Bot,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { LLM_PROVIDERS } from '@/lib/llm/providers';
import {
  SmartUploadSettingsSchema,
  type SmartUploadSettings,
  type ProviderValue,
  type OcrEngineValue,
  type OcrModeValue,
  providerRequiresEndpoint,
} from '@/lib/smart-upload/schema';

// =============================================================================
// Types
// =============================================================================

// step names used for per-step provider selection
export type StepName = 'vision' | 'verification' | 'headerLabel' | 'adjudicator';

interface ModelInfo {
  id: string;
  name: string;
  isVision: boolean;
  priceDisplay: string;
  recommended: boolean;
  recommendationReason?: string;
}

interface ModelsResponse {
  models: ModelInfo[];
  recommendedModel: string | null;
  warning?: string;
}

// =============================================================================
// Component
// =============================================================================

// Model selector with recommended badge
function ModelSelector({
  models,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-[300px]">
        {models.length === 0 ? (
          <SelectItem value="" disabled>
            No models available
          </SelectItem>
        ) : (
          models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              <div className="flex items-center gap-2 w-full">
                <span className="flex-1 truncate">{model.name}</span>
                {model.recommended && (
                  <Badge variant="default" className="bg-primary text-xs">
                    <Sparkles className="h-3 w-3 mr-1" />
                    Recommended
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">{model.priceDisplay}</span>
              </div>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

interface SmartUploadSettingsFormProps {
  settings: Record<string, string>;
}

export function SmartUploadSettingsForm({ settings }: SmartUploadSettingsFormProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [isResettingPrompts, setIsResettingPrompts] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [discoverStatus, setDiscoverStatus] = useState<'idle' | 'discovering' | 'ok' | 'error'>('idle');
  const [discoverMessage, setDiscoverMessage] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Model fetching state
  const [visionModels, setVisionModels] = useState<ModelInfo[]>([]);
  const [verificationModels, setVerificationModels] = useState<ModelInfo[]>([]);
  const [headerLabelModels, setHeaderLabelModels] = useState<ModelInfo[]>([]);
  const [_adjudicatorModels, setAdjudicatorModels] = useState<ModelInfo[]>([]);

  // Per-step loading/error maps — isLoadingModels and modelError are derived below
  const [stepLoading, setStepLoading] = useState<{
    vision: boolean;
    verification: boolean;
    header: boolean;
    adjudicator: boolean;
  }>({ vision: false, verification: false, header: false, adjudicator: false });

  const [stepError, setStepError] = useState<{
    vision?: string | null;
    verification?: string | null;
    header?: string | null;
    adjudicator?: string | null;
  }>({});

  // Derived aggregate loading/error state for the UI
  const isLoadingModels = stepLoading.vision || stepLoading.verification || stepLoading.header || stepLoading.adjudicator;
  const modelError = stepError.vision || stepError.verification || stepError.header || stepError.adjudicator || null;

  // form initialization with schema and default parsing of persisted settings
  const parseBool = (v: unknown) => v === 'true' || v === true;
  const parseNum = (v: unknown) => {
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  };

  const form = useForm<SmartUploadSettings>({
    resolver: zodResolver(SmartUploadSettingsSchema) as any,
    defaultValues: {
      llm_provider: (settings['llm_provider'] as ProviderValue) || '' as ProviderValue,
      llm_endpoint_url: (settings['llm_endpoint_url'] as string) || '',
      llm_default_provider: (settings['llm_default_provider'] as ProviderValue) || '' as ProviderValue,
      llm_vision_model: (settings['llm_vision_model'] as string) || '',
      llm_verification_model: (settings['llm_verification_model'] as string) || '',
      llm_header_label_model: (settings['llm_header_label_model'] as string) || '',
      llm_vision_system_prompt: (settings['llm_vision_system_prompt'] as string) || '',
      llm_verification_system_prompt: (settings['llm_verification_system_prompt'] as string) || '',
      llm_prompt_version: (settings['llm_prompt_version'] as string) || '',
      llm_vision_provider: (settings['llm_vision_provider'] as ProviderValue) || '' as ProviderValue,
      llm_verification_provider: (settings['llm_verification_provider'] as ProviderValue) || '' as ProviderValue,
      llm_header_label_provider: (settings['llm_header_label_provider'] as ProviderValue) || '' as ProviderValue,
      llm_adjudicator_provider: (settings['llm_adjudicator_provider'] as ProviderValue) || '' as ProviderValue,
      smart_upload_confidence_threshold: parseNum(settings['smart_upload_confidence_threshold']),
      smart_upload_auto_approve_threshold: parseNum(settings['smart_upload_auto_approve_threshold']),
      smart_upload_rate_limit_rpm: parseNum(settings['smart_upload_rate_limit_rpm']),
      smart_upload_max_concurrent: parseNum(settings['smart_upload_max_concurrent']),
      llm_two_pass_enabled: parseBool(settings['llm_two_pass_enabled']),
      smart_upload_enable_autonomous_mode: parseBool(settings['smart_upload_enable_autonomous_mode']),
      smart_upload_enable_ocr_first: parseBool(settings['smart_upload_enable_ocr_first']),
      smart_upload_enforce_ocr_splitting: parseBool(settings['smart_upload_enforce_ocr_splitting']),
      smart_upload_store_raw_ocr_text: parseBool(settings['smart_upload_store_raw_ocr_text']),
      smart_upload_text_layer_threshold_pct: parseNum(settings['smart_upload_text_layer_threshold_pct']),
      smart_upload_ocr_max_pages: parseNum(settings['smart_upload_ocr_max_pages']),
      smart_upload_text_probe_pages: parseNum(settings['smart_upload_text_probe_pages']),
      smart_upload_ocr_rate_limit_rpm: parseNum(settings['smart_upload_ocr_rate_limit_rpm']),
      smart_upload_llm_max_pages: parseNum(settings['smart_upload_llm_max_pages']),
      smart_upload_llm_max_header_batches: parseNum(settings['smart_upload_llm_max_header_batches']),
      smart_upload_second_pass_max_images: parseNum(settings['smart_upload_second_pass_max_images']),
      smart_upload_ocr_engine: (settings['smart_upload_ocr_engine'] as OcrEngineValue) || '' as OcrEngineValue,
      smart_upload_ocr_mode: (settings['smart_upload_ocr_mode'] as OcrModeValue) || '' as OcrModeValue,
    },
  });

  const provider = form.watch('llm_provider');
  const defaultProvider = form.watch('llm_default_provider') || provider;
  const endpointUrl = form.watch('llm_endpoint_url');

  // per-step providers (with fallback to default/global)
  const visionProviderVal = form.watch('llm_vision_provider') || defaultProvider;
  const verificationProviderVal = form.watch('llm_verification_provider') || defaultProvider;
  const headerLabelProviderVal = form.watch('llm_header_label_provider') || defaultProvider;
  const adjudicatorProviderVal = form.watch('llm_adjudicator_provider') || defaultProvider;

  // AbortController map for cancelling in-flight model fetches per step
  const fetchAbortRefs = useRef<Record<string, AbortController>>({});

  // Fetch models when provider or API key changes
  const fetchModelsFor = useCallback(
    async (
      providerVal: ProviderValue | string | undefined,
      modelKey: keyof SmartUploadSettings,
      setModels: React.Dispatch<React.SetStateAction<ModelInfo[]>>,
      setLoading: (b: boolean) => void,
      setErr: (msg: string | null) => void
    ) => {
      // Skip if no provider is set
      if (!providerVal || providerVal === '') {
        setModels([]);
        return;
      }

      if (providerVal === 'custom') {
        setModels([]);
        return;
      }

      setLoading(true);
      setErr(null);

      // Cancel any in-flight request for this model key
      const stepKey = String(modelKey);
      fetchAbortRefs.current[stepKey]?.abort();
      const controller = new AbortController();
      fetchAbortRefs.current[stepKey] = controller;

      try {
        const params = new URLSearchParams({ provider: String(providerVal) });
        const endpointValue = form.getValues('llm_endpoint_url');
        if (endpointValue) params.set('endpoint', String(endpointValue));

        const response = await fetch(`/api/admin/uploads/models?${params}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to fetch models');
        }
        const data: ModelsResponse = await response.json();

        setModels(data.models);

        const current = form.getValues(modelKey);
        const currentStr = String(current);
        const validModelIds = data.models.map((m) => m.id);
        if ((!current || !validModelIds.includes(currentStr)) && data.recommendedModel) {
          // special handling for verification cheaper model
          if (modelKey === 'llm_verification_model') {
            const verificationModel =
              data.models.find((m) => !m.recommended && m.priceDisplay.includes('Free'))?.id ||
              data.recommendedModel;
            form.setValue(modelKey, verificationModel);
          } else {
            form.setValue(modelKey, data.recommendedModel);
          }
        }

        if (data.warning) {
          toast.warning(data.warning);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const message = error instanceof Error ? error.message : 'Failed to fetch models';
        setErr(message);
        toast.error(message);
      } finally {
        setLoading(false);
      }
    },
    [form]
  );

  const fetchAllModels = useCallback(() => {
    fetchModelsFor(visionProviderVal, 'llm_vision_model', setVisionModels, (b) =>
      setStepLoading((p) => ({ ...p, vision: b }))
    , (m) => setStepError((p) => ({ ...p, vision: m })))
      .catch(() => {});
    fetchModelsFor(verificationProviderVal, 'llm_verification_model', setVerificationModels, (b) =>
      setStepLoading((p) => ({ ...p, verification: b }))
    , (m) => setStepError((p) => ({ ...p, verification: m })))
      .catch(() => {});
    fetchModelsFor(headerLabelProviderVal, 'llm_header_label_model', setHeaderLabelModels, (b) =>
      setStepLoading((p) => ({ ...p, header: b }))
    , (m) => setStepError((p) => ({ ...p, header: m })))
      .catch(() => {});
    fetchModelsFor(adjudicatorProviderVal, 'llm_adjudicator_model', setAdjudicatorModels, (b) =>
      setStepLoading((p) => ({ ...p, adjudicator: b }))
    , (m) => setStepError((p) => ({ ...p, adjudicator: m })))
      .catch(() => {});
  }, [visionProviderVal, verificationProviderVal, headerLabelProviderVal, adjudicatorProviderVal, fetchModelsFor]);

  // Fetch models on initial load and when dependencies change
  useEffect(() => {
    if (visionProviderVal) fetchAllModels();
  }, [
    visionProviderVal,
    verificationProviderVal,
    headerLabelProviderVal,
    adjudicatorProviderVal,
    endpointUrl,
    fetchAllModels
  ]);

  const handleProviderChange = (value: ProviderValue) => {
    form.setValue('llm_provider', value);
    
    const config = LLM_PROVIDERS.find((p) => p.value === value);
    if (config) {
      // Set endpoint for custom provider
      if (value === 'custom') {
        form.setValue('llm_endpoint_url', '');
      } else {
        form.setValue('llm_endpoint_url', config.defaultEndpoint);
      }

      // Clear models until we fetch new ones
      form.setValue('llm_vision_model', '');
      form.setValue('llm_verification_model', '');
      form.setValue('llm_header_label_model', '');
    }
  };

  const handleStepProviderChange = (step: StepName, value: ProviderValue) => {
    const key =
      step === 'vision'
        ? 'llm_vision_provider'
        : step === 'verification'
        ? 'llm_verification_provider'
        : step === 'headerLabel'
        ? 'llm_header_label_provider'
        : 'llm_adjudicator_provider';
    form.setValue(key as keyof SmartUploadSettings, value);
    // clear associated model so UI forces reselect
    let modelKey = '';
    if (step === 'vision') modelKey = 'llm_vision_model';
    if (step === 'verification') modelKey = 'llm_verification_model';
    if (step === 'headerLabel') modelKey = 'llm_header_label_model';
    if (step === 'adjudicator') modelKey = 'llm_adjudicator_model';
    form.setValue(modelKey as keyof SmartUploadSettings, '');
  };

  const onSubmit = async (values: SmartUploadSettings) => {
    setIsSaving(true);
    try {
      const settingsToUpdate = Object.entries(values).map(([key, value]) => ({
        key,
        value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
      }));

      const res = await fetch('/api/admin/uploads/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: settingsToUpdate }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `Server error ${res.status}`);
      }

      toast.success('Smart Upload settings saved successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save settings';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetPrompts = async () => {
    setIsResettingPrompts(true);
    try {
      const res = await fetch('/api/admin/uploads/settings/reset-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `Server error ${res.status}`);
      }

      const data = await res.json();
      
      // Update form values
      if (data.prompts) {
        form.setValue('llm_vision_system_prompt', data.prompts.llm_vision_system_prompt);
        form.setValue('llm_verification_system_prompt', data.prompts.llm_verification_system_prompt);
        form.setValue('llm_prompt_version', data.prompts.llm_prompt_version);
      }

      toast.success('Prompts reset to defaults');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to reset prompts';
      toast.error(msg);
    } finally {
      setIsResettingPrompts(false);
    }
  };

  const testConnection = async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const values = form.getValues();

      const res = await fetch('/api/admin/uploads/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: values.llm_provider,
          endpoint: values.llm_endpoint_url || '',
          model: values.llm_vision_model,
        }),
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        setTestStatus('ok');
        setTestMessage(data.message ?? 'Connection successful');
      } else {
        setTestStatus('error');
        setTestMessage(data.error ?? `Connection failed (${res.status})`);
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Network error');
    }
  };

  const discoverProviders = async () => {
    setDiscoverStatus('discovering');
    setDiscoverMessage('');
    try {
      const res = await fetch('/api/admin/uploads/providers/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setDiscoverStatus('ok');
        setDiscoverMessage(data.message ?? 'Discovery complete');
        if (data.settingsWritten?.length > 0) {
          toast.success(`Auto-configured: ${data.message}`);
          // Reload to pick up newly written settings
          window.location.reload();
        }
      } else {
        setDiscoverStatus('error');
        setDiscoverMessage(data.error ?? 'Discovery failed');
      }
    } catch (err) {
      setDiscoverStatus('error');
      setDiscoverMessage(err instanceof Error ? err.message : 'Network error');
    }
  };

  const requiresEndpoint = providerRequiresEndpoint(provider);
  const usingGlmOcr = [
    provider,
    defaultProvider,
    visionProviderVal,
    verificationProviderVal,
    headerLabelProviderVal,
    adjudicatorProviderVal,
  ].includes('glm-ocr');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Provider Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" />
              Provider Routing
            </CardTitle>
            <CardDescription>
              Choose the AI provider for metadata extraction. Local providers are preferred for
              privacy and controlled Smart Upload rollouts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="llm_provider"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider</FormLabel>
                  <Select value={field.value} onValueChange={(v) => handleProviderChange(v as ProviderValue)}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {LLM_PROVIDERS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          <div className="flex flex-col">
                            <span>{p.label}</span>
                            <span className="text-xs text-muted-foreground">{p.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Endpoint URL (editable endpoint for the current default provider) */}
            {requiresEndpoint && (
              <FormField
                control={form.control}
                name="llm_endpoint_url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Endpoint URL</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="https://api.example.com/v1"
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormDescription>
                      Base URL for the current default provider. Per-step providers that differ fall back to their own provider endpoint.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Model Fetch Error */}
            {modelError && (
              <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 flex gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{modelError}</span>
              </div>
            )}

            {usingGlmOcr && (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 flex gap-2">
                <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>
                  GLM-OCR is image-based. Keep OCR-first enabled, keep full-PDF sending disabled,
                  and keep auto-commit conservative until fixture benchmarks are complete.
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Model Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Model Configuration
            </CardTitle>
            <CardDescription>
              Select which models to use for the two-pass extraction pipeline.
              Models are automatically fetched from the provider.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={fetchAllModels}
                disabled={isLoadingModels || provider === 'custom'}
              >
                {isLoadingModels ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                <span className="ml-2">{isLoadingModels ? 'Loading...' : 'Refresh Models'}</span>
              </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="llm_vision_model"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vision Model (1st pass)</FormLabel>
                    <FormControl>
                      {provider === 'custom' ? (
                        <Input
                          placeholder="Enter model name"
                          {...field}
                          value={field.value || ''}
                        />
                      ) : (
                        <ModelSelector
                          models={visionModels}
                          value={field.value || ''}
                          onChange={field.onChange}
                          disabled={isLoadingModels || !!modelError}
                          placeholder="Select vision model"
                        />
                      )}
                    </FormControl>
                    <FormDescription>Must support image inputs for reading PDF pages</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="llm_verification_model"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Verification Model (2nd pass)</FormLabel>
                    <FormControl>
                      {provider === 'custom' ? (
                        <Input
                          placeholder="Enter model name"
                          {...field}
                          value={field.value || ''}
                        />
                      ) : (
                        <ModelSelector
                          models={verificationModels}
                          value={field.value || ''}
                          onChange={field.onChange}
                          disabled={isLoadingModels || !!modelError}
                          placeholder="Select verification model"
                        />
                      )}
                    </FormControl>
                    <FormDescription>Can be faster/cheaper than vision model</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="llm_header_label_model"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Header Label Model</FormLabel>
                    <FormControl>
                      {provider === 'custom' ? (
                        <Input
                          placeholder="Enter model name"
                          {...field}
                          value={field.value || ''}
                        />
                      ) : (
                        <ModelSelector
                          models={headerLabelModels}
                          value={field.value || ''}
                          onChange={field.onChange}
                          disabled={isLoadingModels || !!modelError}
                          placeholder="Select header-label model"
                        />
                      )}
                    </FormControl>
                    <FormDescription>Used only for header labelling when set</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Per-step provider dropdowns */}
            <div className="mt-6">
              <CardTitle className="text-base">Per-step Providers</CardTitle>
              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="llm_vision_provider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Vision Step Provider</FormLabel>
                      <Select
                        value={field.value || ''}
                        onValueChange={(v) => handleStepProviderChange('vision', v as ProviderValue)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="(use default)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="">Use default</SelectItem>
                          {LLM_PROVIDERS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="llm_verification_provider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Verification Step Provider</FormLabel>
                      <Select
                        value={field.value || ''}
                        onValueChange={(v) => handleStepProviderChange('verification', v as ProviderValue)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="(use default)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="">Use default</SelectItem>
                          {LLM_PROVIDERS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="llm_header_label_provider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Header-label Step Provider</FormLabel>
                      <Select
                        value={field.value || ''}
                        onValueChange={(v) => handleStepProviderChange('headerLabel', v as ProviderValue)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="(use default)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="">Use default</SelectItem>
                          {LLM_PROVIDERS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="llm_adjudicator_provider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Adjudicator Step Provider</FormLabel>
                      <Select
                        value={field.value || ''}
                        onValueChange={(v) => handleStepProviderChange('adjudicator', v as ProviderValue)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="(use default)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="">Use default</SelectItem>
                          {LLM_PROVIDERS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Model params for header/adjudicator later */}
          </CardContent>
        </Card>

        {/* System Prompts */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  System Prompts
                </CardTitle>
                <CardDescription>
                  Customize the AI prompts used for metadata extraction.
                  Reset to defaults if you encounter issues.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleResetPrompts}
                disabled={isResettingPrompts}
              >
                {isResettingPrompts ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                <span className="ml-2">Reset to Defaults</span>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 flex gap-2">
              <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <p>
                These prompts control how the AI extracts metadata from your PDFs.
                Only modify if you understand the JSON output requirements.
              </p>
            </div>

            <FormField
              control={form.control}
              name="llm_vision_system_prompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Vision System Prompt</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={8}
                      className="font-mono text-xs"
                      {...field}
                      value={field.value || ''}
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Instructions for the first-pass vision model. Must request JSON output.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="llm_verification_system_prompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Verification System Prompt</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={6}
                      className="font-mono text-xs"
                      {...field}
                      value={field.value || ''}
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Instructions for the second-pass verification model.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Advanced Settings */}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Advanced Settings</CardTitle>
                    <CardDescription>
                      Confidence thresholds and processing limits.
                    </CardDescription>
                  </div>
                  <ChevronDown
                    className={cn(
                      'h-5 w-5 text-muted-foreground transition-transform',
                      advancedOpen && 'rotate-180'
                    )}
                  />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="space-y-4 pt-0">
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="smart_upload_confidence_threshold"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Confidence Threshold (%)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            {...field}
                            value={field.value}
                            onChange={(e) => field.onChange(Number(e.target.value))}
                          />
                        </FormControl>
                        <FormDescription className="text-xs">
                          Minimum confidence to accept without verification
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="smart_upload_auto_approve_threshold"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Auto-Approve Threshold (%)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            {...field}
                            value={field.value}
                            onChange={(e) => field.onChange(Number(e.target.value))}
                          />
                        </FormControl>
                        <FormDescription className="text-xs">
                          Confidence required for automatic approval
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="smart_upload_rate_limit_rpm"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Rate Limit (RPM)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            max={1000}
                            {...field}
                            value={field.value}
                            onChange={(e) => field.onChange(Number(e.target.value))}
                          />
                        </FormControl>
                        <FormDescription className="text-xs">Maximum LLM requests per minute</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="smart_upload_max_concurrent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max Concurrent Jobs</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            max={50}
                            {...field}
                            value={field.value}
                            onChange={(e) => field.onChange(Number(e.target.value))}
                          />
                        </FormControl>
                        <FormDescription className="text-xs">Maximum simultaneous upload processing jobs</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="llm_two_pass_enabled"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0 pt-2">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>Enable Two-Pass Verification</FormLabel>
                        <FormDescription className="text-xs">
                          Run a second LLM pass when confidence is below threshold
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Autonomous Mode */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" />
              Autonomous Mode
            </CardTitle>
            <CardDescription>
              When enabled, uploads whose confidence score meets the threshold are automatically
              committed to the library without requiring human review.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="smart_upload_enable_autonomous_mode"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center space-x-3 space-y-0">
                  <FormControl>
                    <Switch
                      checked={!!field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>Enable Fully Autonomous Mode</FormLabel>
                    <FormDescription className="text-xs">
                      Automatically commit high-confidence uploads — no human approval needed.
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="smart_upload_autonomous_approval_threshold"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Autonomous Approval Threshold (%)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={field.value as number ?? 95}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Uploads with confidence ≥ this value are auto-committed (0–100).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="llm_adjudicator_model"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Adjudicator Model <span className="text-muted-foreground">(optional)</span></FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder="e.g. gemma3:27b — defaults to vision model if blank"
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={(field.value as string) ?? ''}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Model used for second-pass adjudication. Leave blank to reuse the vision model.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* OCR-first configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              OCR-first Settings
            </CardTitle>
            <CardDescription>
              Configure the OCR-first pipeline that runs before the LLM.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="smart_upload_enable_ocr_first"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center space-x-3 space-y-0">
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>Enable OCR-first Pipeline</FormLabel>
                    <FormDescription className="text-xs">
                      Run OCR ahead of the LLM to improve accuracy on scanned PDFs.
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="smart_upload_enforce_ocr_splitting"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center space-x-3 space-y-0">
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>Enforce OCR for splitting</FormLabel>
                    <FormDescription className="text-xs">
                      Prefer OCR-derived page splitting instructions even when the LLM is more confident.
                      LLM is still used as a fallback when OCR results are invalid.
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="smart_upload_text_layer_threshold_pct"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Text Layer Threshold (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        {...field}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Percent confidence required to skip OCR (0–100).
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="smart_upload_ocr_engine"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>OCR Engine</FormLabel>
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select engine" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="tesseract">Tesseract</SelectItem>
                          <SelectItem value="ocrmypdf">ocrmypdf</SelectItem>
                          <SelectItem value="vision_api">Vision API</SelectItem>
                          <SelectItem value="native">Native</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormDescription className="text-xs">
                      Engine used for OCR processing.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="smart_upload_ocr_mode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>OCR Mode</FormLabel>
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select mode" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="header">Header Only</SelectItem>
                          <SelectItem value="full">Full Document</SelectItem>
                          <SelectItem value="both">Headers + Full</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormDescription className="text-xs">
                      Choose pages to run OCR on.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="smart_upload_ocr_max_pages"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max OCR Pages</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        {...field}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Maximum number of pages to run OCR on.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="smart_upload_text_probe_pages"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Text Probe Pages</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        {...field}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Pages to inspect for an existing text layer.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="smart_upload_store_raw_ocr_text"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 pt-2">
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Store Raw OCR Text</FormLabel>
                      <FormDescription className="text-xs">
                        Save OCR output to the database for debugging.
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="smart_upload_ocr_rate_limit_rpm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>OCR Rate Limit (RPM)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        {...field}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Max OCR jobs per minute.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="smart_upload_llm_max_pages"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>LLM Max Pages</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        {...field}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Maximum pages sent to LLM after OCR.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="smart_upload_llm_max_header_batches"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>LLM Max Header Batches</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      {...field}
                      value={field.value}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Limit for header-label LLM batching.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="smart_upload_second_pass_max_images"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max Images per Second-Pass Request</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={200}
                      {...field}
                      value={field.value}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Maximum images sent to the LLM in a single second-pass request.
                    0 = use the provider-level cap (recommended).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Test Connection */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Test Connection &amp; Auto-Discovery</CardTitle>
            <CardDescription>Verify your endpoint or let the system find a free provider automatically</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={testConnection}
                disabled={testStatus === 'testing'}
              >
                {testStatus === 'testing' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Wifi className="mr-2 h-4 w-4" />
                )}
                {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
              </Button>

              <Button
                type="button"
                variant="secondary"
                onClick={discoverProviders}
                disabled={discoverStatus === 'discovering'}
              >
                {discoverStatus === 'discovering' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="mr-2 h-4 w-4" />
                )}
                {discoverStatus === 'discovering' ? 'Discovering...' : 'Discover & Configure Free Providers'}
              </Button>
            </div>

            {testStatus === 'ok' && (
              <span className="flex items-center gap-1.5 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                {testMessage}
              </span>
            )}
            {testStatus === 'error' && (
              <span className="flex items-center gap-1.5 text-sm text-red-600">
                <AlertCircle className="h-4 w-4" />
                {testMessage}
              </span>
            )}
            {discoverStatus === 'ok' && (
              <span className="flex items-center gap-1.5 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                {discoverMessage}
              </span>
            )}
            {discoverStatus === 'error' && (
              <span className="flex items-center gap-1.5 text-sm text-red-600">
                <AlertCircle className="h-4 w-4" />
                {discoverMessage}
              </span>
            )}
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isSaving} size="lg">
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save Settings
              </>
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
