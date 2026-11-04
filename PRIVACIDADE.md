# Privacidade e acesso

O código é público. Cadastros, relatórios, observações e backups não integram o repositório nem arquivos públicos de inicialização.

Supabase Auth verifica o login. Uma lista privada de responsáveis, seus vínculos e regras de segurança por linha restringem a leitura ao grupo atribuído. Administradores do sistema podem gerenciar todos os grupos e usuários. Visitantes e contas não autorizadas não recebem os registros. Não basta alterar um identificador no navegador para acessar outro grupo. Gravações usam função com revisão atômica por grupo; o navegador não pode escrever diretamente nas tabelas ou atribuir a si mesmo outro grupo.

A chave publishable e a URL são identificadores públicos. Não dão acesso aos dados por si só. Nunca publique senha, chave secreta ou service_role.

A comunicação usa HTTPS. O SDK persiste a sessão do usuário no navegador. Use aparelhos confiáveis e saia da conta em aparelhos compartilhados. Sair remove os dados da interface; proteja separadamente arquivos JSON e PDF já baixados.

Em conflito ou falha de rede, confira o estado remoto antes de repetir uma gravação: uma requisição pode ter sido aceita antes da conexão cair. Não há mesclagem automática de duas edições.

Importar substitui somente a base do grupo selecionado. Preserve um backup anterior e confira qual grupo está aberto antes de confirmar. A transferência de um responsável para outro grupo muda seu acesso e não move nem apaga os publicadores do grupo anterior. O aplicativo não apaga nem importa automaticamente o armazenamento da versão local antiga. O plano Free pode ter pausas e limites; mantenha backups privados externos.

O cadastro de usuários é realizado por uma função de servidor, após verificar que a sessão pertence a um administrador. Senhas vão diretamente ao serviço de autenticação, não integram os relatórios, backups ou arquivos públicos. Em caso de falha parcial ao cadastrar, confira a lista de usuários e conclua o vínculo; não repita uma criação automaticamente nem altere a senha de uma conta existente.

Referências: [segurança](https://supabase.com/docs/guides/database/secure-data), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [sessões](https://supabase.com/docs/guides/auth/sessions).
