export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'number'
  | 'date'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'phone';

export type FormRecord = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: 'active';
  submit_label: string;
  success_message: string | null;
  notification_recipient_user_id: string | null;
};

export type FormField = {
  id: string;
  form_id: string;
  field_key: string;
  label: string;
  type: FormFieldType;
  required: number;
  placeholder: string | null;
  help_text: string | null;
  options_json: string | null;
  sort_order: number;
  status: 'active';
};

export type FormFieldOption = {
  value: string;
  label: string;
};

export type PublicFormField = {
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  placeholder: string | null;
  help_text: string | null;
  options: FormFieldOption[];
  sort_order: number;
};

export type FormSubmissionValueInput = {
  fieldId: string;
  fieldKey: string;
  fieldLabel: string;
  fieldType: FormFieldType;
  value: string;
};
