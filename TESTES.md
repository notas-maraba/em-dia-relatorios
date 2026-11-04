# Verificação

npm run check confere sintaxe. npm test executa regras de negócio e PDF, cliente de nuvem e ciclo de autenticação/gravação da interface com dados fictícios.

Os testes conferem sessão verificada, autorização, base vazia, falhas de rede, conflitos e ausência de repetição automática de gravação. A interface deve ocultar dados antes do login, confirmar alterações só após resposta do banco e limpar a tela ao sair.

tests/security.sql simula papéis JWT dentro de uma transação com rollback no projeto dedicado. Verifica visitante, conta não autorizada, tentativa de autoautorização, isolamento do dono, gravação direta negada e revisão obsoleta recusada. Nenhum registro fictício deve permanecer.

Antes de liberar, confira no navegador login, saída, recarga, abas, cadastro, relatórios, PDF, backup e dados importados. Confira tela pequena e segunda sessão. Testes de módulos não substituem essas verificações. Não altere dados reais apenas para testar nem publique evidências com nomes reais.
