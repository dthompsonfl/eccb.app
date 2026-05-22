'use client';

/**
 * Database Config Form Component
 *
 * Form for entering database configuration details.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusDisplay } from './status-display';

interface DatabaseConfigFormProps {
  onSubmit: (config: DatabaseConfig) => Promise<void>;
  isLoading?: boolean;
  disableSubmit?: boolean;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

type FormStatus = 'idle' | 'testing' | 'success' | 'error';

export function DatabaseConfigForm({
  onSubmit,
  isLoading = false,
  disableSubmit = false,
}: DatabaseConfigFormProps): React.ReactElement {
  const [formData, setFormData] = useState<DatabaseConfig>({
    host: 'localhost',
    port: 3306,
    username: 'root',
    password: '',
    database: 'eccb',
  });
  const [status, setStatus] = useState<FormStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const handleChange = (field: keyof DatabaseConfig, value: string | number): void => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setStatus('testing');
    setErrorMessage('');

    try {
      await onSubmit(formData);
      setStatus('success');
    } catch (error) {
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Connection failed');
    }
  };

  return (
    <Card className="border-slate-700 bg-slate-800/50">
      <CardHeader>
        <CardTitle className="text-white">Database Configuration</CardTitle>
        <CardDescription className="text-slate-400">
          Enter your database connection details. For local development, you can use the defaults.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Host */}
          <div className="space-y-2">
            <Label htmlFor="host" className="text-slate-300">
              Database Host
            </Label>
            <Input
              id="host"
              type="text"
              placeholder="localhost"
              value={formData.host}
              onChange={(e) => handleChange('host', e.target.value)}
              disabled={isLoading}
              className="border-slate-600 bg-slate-900 text-white placeholder:text-slate-500"
            />
          </div>

          {/* Port */}
          <div className="space-y-2">
            <Label htmlFor="port" className="text-slate-300">
              Port
            </Label>
            <Input
              id="port"
              type="number"
              placeholder="3306"
              value={formData.port}
              onChange={(e) => handleChange('port', parseInt(e.target.value, 10))}
              disabled={isLoading}
              className="border-slate-600 bg-slate-900 text-white placeholder:text-slate-500"
            />
          </div>

          {/* Username */}
          <div className="space-y-2">
            <Label htmlFor="username" className="text-slate-300">
              Username
            </Label>
            <Input
              id="username"
              type="text"
              placeholder="root"
              value={formData.username}
              onChange={(e) => handleChange('username', e.target.value)}
              disabled={isLoading}
              className="border-slate-600 bg-slate-900 text-white placeholder:text-slate-500"
            />
          </div>

          {/* Password */}
          <div className="space-y-2">
            <Label htmlFor="password" className="text-slate-300">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              placeholder="Enter password"
              value={formData.password}
              onChange={(e) => handleChange('password', e.target.value)}
              disabled={isLoading}
              className="border-slate-600 bg-slate-900 text-white placeholder:text-slate-500"
            />
          </div>

          {/* Database Name */}
          <div className="space-y-2">
            <Label htmlFor="database" className="text-slate-300">
              Database Name
            </Label>
            <Input
              id="database"
              type="text"
              placeholder="eccb"
              value={formData.database}
              onChange={(e) => handleChange('database', e.target.value)}
              disabled={isLoading}
              className="border-slate-600 bg-slate-900 text-white placeholder:text-slate-500"
            />
          </div>

          {/* Status Display */}
          {status === 'testing' && (
            <StatusDisplay
              type="loading"
              title="Testing Connection..."
              message="Please wait while we verify your database connection."
            />
          )}

          {status === 'error' && (
            <StatusDisplay
              type="error"
              title="Connection Failed"
              message={errorMessage || 'Could not connect to the database. Please check your settings.'}
            />
          )}

          {/* Submit Button */}
          <Button
            type="submit"
            disabled={isLoading || status === 'testing' || disableSubmit}
            className="w-full bg-primary hover:bg-primary/90"
          >
            {isLoading ? 'Connecting...' : 'Test & Continue'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
