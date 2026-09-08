export type NewsletterList = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: string;
};

export type NewsletterFieldType = 'text' | 'textarea' | 'number' | 'url' | 'boolean' | 'select' | 'radio' | 'checkbox';

export type NewsletterFieldOption = {
  value: string;
  label: string;
};

export type NewsletterField = {
  id: string;
  newsletter_id: string;
  field_key: string;
  label: string;
  type: NewsletterFieldType;
  required: number;
  options_json: string | null;
  sort_order: number;
  status: string;
};

export type PublicNewsletterField = {
  key: string;
  label: string;
  type: NewsletterFieldType;
  required: boolean;
  options: NewsletterFieldOption[];
  sort_order: number;
};

export type Subscriber = {
  id: string;
  email: string;
};

export type Subscription = {
  id: string;
  newsletter_id: string;
  subscriber_id: string;
  status: 'pending' | 'subscribed' | 'unsubscribed';
  confirm_email_status?: 'not_sent' | 'sent' | 'failed' | null;
  confirm_email_error?: string | null;
};

export type NewsletterFieldValueInput = {
  fieldId: string;
  value: string;
};
