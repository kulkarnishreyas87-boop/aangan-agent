# Confirmation call agent (set up as a second agent in Vaani)

Create a second Vaani agent for the call-back that confirms a consultation. Our server triggers it with these template variables in `metadata`: `customer_name`, `consultation_time` (a spoken date and time, for example "Monday 12 October at 9 AM"), `visit_type` ("site visit" or "phone call").

Suggested prompt:

> You are calling from Aangan Studio, a Pune interior design studio. Greet {{customer_name}} and say you are calling to confirm their free first consultation, a {{visit_type}}, on {{consultation_time}}. Ask if that time works. If yes, thank them and end the call. If not, ask what day and time suits them better, say the team will arrange it and call back, thank them and end the call. Do not discuss prices. Keep each turn to one or two short sentences. Speak English, Hindi or Marathi to match the customer.

After the call, Vaani's `call_postprocessing` webhook delivers the transcript. Our server reads it and marks the booking confirmed, or emails the front desk if the customer wants a different time.
