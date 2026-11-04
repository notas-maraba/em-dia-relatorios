# Privacidade e acesso

O código é público. Cadastros, relatórios, observações e backups não integram o repositório nem arquivos públicos de inicialização.

Supabase Auth verifica o login. Uma lista privada de responsáveis e regras de segurança por linha restringem a leitura à própria base. Visitantes e contas não autorizadas não recebem os registros. Gravações usam função com revisão atômica; o navegador não pode escrever diretamente nas tabelas.

A chave publishable e a URL são identificadores públicos. Não dão acesso aos dados por si só. Nunca publique senha, chave secreta ou service_role.

A comunicação usa HTTPS. O SDK persiste a sessão do usuário no navegador. Use aparelhos confiáveis e saia da conta em aparelhos compartilhados. Sair remove os dados da interface; proteja separadamente arquivos JSON e PDF já baixados.

Em conflito ou falha de rede, confira o estado remoto antes de repetir uma gravação: uma requisição pode ter sido aceita antes da conexão cair. Não há mesclagem automática de duas edições.

Importar substitui a base inteira da conta. Preserve um backup anterior. O aplicativo não apaga nem importa automaticamente o armazenamento da versão local antiga. O plano Free pode ter pausas e limites; mantenha backups privados externos.

Referências: [segurança](https://supabase.com/docs/guides/database/secure-data), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [sessões](https://supabase.com/docs/guides/auth/sessions).
