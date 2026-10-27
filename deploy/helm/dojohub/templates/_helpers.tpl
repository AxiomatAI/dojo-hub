{{- define "dojohub.name" -}}{{ .Chart.Name }}{{- end -}}
{{- define "dojohub.fullname" -}}{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}{{- end -}}
{{- define "dojohub.labels" -}}
app.kubernetes.io/name: {{ include "dojohub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
{{- define "dojohub.selector" -}}
app.kubernetes.io/name: {{ include "dojohub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "dojohub.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "dojohub.secretName" -}}{{ .Values.existingSecret | default (include "dojohub.fullname" .) }}{{- end -}}
{{- define "dojohub.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}postgres://dojohub:{{ .Values.postgresql.password }}@{{ include "dojohub.fullname" . }}-postgresql:5432/dojohub{{- else -}}{{ .Values.database.url }}{{- end -}}
{{- end -}}
{{- define "dojohub.env" -}}
- name: DOJO_BASE_URL
  value: {{ .Values.baseUrl | quote }}
- name: DOJO_AUTH_LOCAL
  value: {{ .Values.auth.local | quote }}
- name: DOJO_BOOTSTRAP_ADMIN_EMAIL
  value: {{ .Values.auth.bootstrapAdminEmail | quote }}
{{- if .Values.auth.setupToken }}
- name: DOJO_SETUP_TOKEN
  value: {{ .Values.auth.setupToken | quote }}
{{- end }}
- name: STORAGE_DRIVER
  value: {{ .Values.storage.driver | quote }}
{{- if eq .Values.storage.driver "s3" }}
- name: S3_BUCKET
  value: {{ .Values.storage.s3.bucket | quote }}
- name: S3_REGION
  value: {{ .Values.storage.s3.region | quote }}
- name: S3_ENDPOINT
  value: {{ .Values.storage.s3.endpoint | quote }}
- name: S3_FORCE_PATH_STYLE
  value: {{ .Values.storage.s3.forcePathStyle | quote }}
{{- end }}
- name: DOJO_SECRET_KEY
  valueFrom: { secretKeyRef: { name: {{ include "dojohub.secretName" . }}, key: DOJO_SECRET_KEY } }
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "dojohub.secretName" . }}, key: DATABASE_URL } }
- name: S3_ACCESS_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ include "dojohub.secretName" . }}, key: S3_ACCESS_KEY_ID, optional: true } }
- name: S3_SECRET_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ include "dojohub.secretName" . }}, key: S3_SECRET_ACCESS_KEY, optional: true } }
- name: GITHUB_TOKEN
  valueFrom: { secretKeyRef: { name: {{ include "dojohub.secretName" . }}, key: GITHUB_TOKEN, optional: true } }
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}
{{- define "dojohub.volumes" -}}
- name: data
{{- if .Values.persistence.enabled }}
  persistentVolumeClaim:
    claimName: {{ .Values.persistence.existingClaim | default (printf "%s-data" (include "dojohub.fullname" .)) }}
{{- else }}
  emptyDir: {}
{{- end }}
{{- end -}}
